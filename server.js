require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ Connected to MongoDB"));

// --- BREVO CONFIG ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: { type: String },
    role: { type: String, default: 'visitor' }, // visitor, captain, admin
    isVerified: { type: Boolean, default: false },
    otp: String,
    otpExpires: Date
});

const playerSchema = new mongoose.Schema({
    name: String, strength: Number, cardType: String, baseValue: Number, division: Number, // NEW
    phone: Number,
    imageUrl: String,
    status: { type: String, default: 'Available' }, soldTo: { type: String, default: '-' }
});

const teamSchema = new mongoose.Schema({ name: String, budget: Number });

const chatSchema = new mongoose.Schema({ 
    sender: String, role: String, text: String, timestamp: { type: Date, default: Date.now } 
});

const User = mongoose.model('User', userSchema);
const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const Chat = mongoose.model('Chat', chatSchema);

// --- HARDCODED CREDENTIALS (As requested) ---


// --- AUTH UTILITIES ---
async function sendOTPEmail(email, otp) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "PES PARK Verification Code";
    sendSmtpEmail.htmlContent = `<html><body><h1>Your OTP: ${otp}</h1><p>Use this code to verify your account.</p></body></html>`;
    sendSmtpEmail.sender = { "name": "PES PARK", "email": process.env.BREVO_SENDER_EMAIL };
    sendSmtpEmail.to = [{ "email": email }];
    return apiInstance.sendTransacEmail(sendSmtpEmail);
}

// --- AUTOMATIC TEAM SEEDING ---



// Add this temporary seeding logic at the bottom of server.js
async function createMasterAdmin() {
    const exists = await User.findOne({ email: "sarkaranubhav48@gmail.com" });
    if (!exists) {
        const hashedPassword = await bcrypt.hash("admin123", 10);
        await User.create({
            name: "Nexus Master Admin",
            email: "sarkaranubhav48@gmail.com",
            password: hashedPassword,
            role: "admin",
            isVerified: true
        });
        console.log("👑 Master Admin Account Created.");
    }
}
createMasterAdmin();

// --- HTTP ROUTES ---
app.get('/reset-teams', async (req, res) => {
    try {
        await Team.deleteMany({}); 
        await Team.insertMany(teamList);
        res.send("✅ Teams successfully reset to 2000L!");
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/fix-budgets', async (req, res) => {
    try {
        await Team.updateMany({}, { $set: { budget: 2000 } });
        res.send("✅ All budgets reset to 2000L!");
    } catch (e) { res.status(500).send(e.message); }
});

// --- AUCTION LOGIC & TIMER ---
let auctionState = { 
    activePlayerId: null, 
    currentBid: 0, 
    highestBidder: 'No Bids Yet', 
    timeLeft: 120,
    skippedTeams: [],
    isFinalCall: false,     // NEW
    finalCallText: ""

};
let timerInterval = null;

function getFinalCallText(seconds) {
    if (seconds > 25) return "Are there any further bids?";
    if (seconds > 20) return "For the first time...";
    if (seconds > 15) return "For the second time...";
    if (seconds > 10) return "Going once...";
    if (seconds > 5) return "Going twice...";
    if (seconds > 0) return "SOLD!";
    return "SOLD!";
}

function startTimer() {
    clearInterval(timerInterval);
    // If it's a final call, we start from 30, otherwise standard 60 (or 120 as you mentioned)
    auctionState.timeLeft = auctionState.isFinalCall ? 30 : 120; 
    
    timerInterval = setInterval(async () => {
        auctionState.timeLeft--;
        
        if (auctionState.isFinalCall) {
            auctionState.finalCallText = getFinalCallText(auctionState.timeLeft);
        }
        if (auctionState.timeLeft <= 0) {
            clearInterval(timerInterval);
            await autoSellPlayer();
        } else {
            io.emit('updateAuction', auctionState);
        }
    }, 1000);
}

async function autoSellPlayer() {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        const price = auctionState.currentBid;
        const teamName = auctionState.highestBidder;

        await Player.findByIdAndUpdate(auctionState.activePlayerId._id, {
            status: 'Sold',
            soldTo: `${teamName} (${price}M)`
        });
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: -price } });

        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `🔴 SOLD! ${teamName} bought the player for ${price}L.` });
    } else {
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    }
}

// --- SOCKETS ---
io.on('connection', async (socket) => {
    socket.emit('initialData', {
        players: await Player.find(),
        teams: await Team.find(),
        chats: await Chat.find().sort({ timestamp: 1 }).limit(50),
        state: auctionState
    });

    // --- NEW: AUTHENTICATION EVENTS ---

    

    // 2. Special Sign In (Captain/Admin)
    socket.on('specialSignIn', async ({ email, password, type }) => {
    try {
        const user = await User.findOne({ email, role: type });
        
        if (!user) return socket.emit('errorMsg', "User not found in authorized list.");

        // Compare entered password with hashed password in DB
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (isMatch) {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.otp = otp;
            user.otpExpires = Date.now() + 600000; // 10 mins
            await user.save();
            await sendOTPEmail(email, otp);
            socket.emit('authStep', 'otp_verify');
        } else {
            socket.emit('errorMsg', "Incorrect Password.");
        }
    } catch (e) { socket.emit('errorMsg', "Auth Error"); }
});

// --- ADMIN MANAGEMENT FUNCTIONS ---
socket.on('getAuthorizedUsers', async () => {
    // Only send non-visitors to admin
    const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
    socket.emit('authorizedUsersList', users);
});
    socket.on('createNewUser', async (data) => {
    try {
        const hashedPassword = await bcrypt.hash(data.password, 10);
        const userEmail = data.email.trim().toLowerCase();
        const teamName = data.teamName.trim();
        const customBudget = Number(data.budget); // GET VARIABLE BUDGET

        // 1. Create/Update the User
        await User.findOneAndUpdate(
            { email: userEmail },
            {
                name: teamName, 
                email: userEmail,
                password: hashedPassword,
                role: data.role,
                isVerified: true
            },
            { upsert: true }
        );

        // 2. Link to Franchise with Variable Budget
        if (data.role === 'captain') {
            await Team.findOneAndUpdate(
                { name: teamName },
                { 
                    name: teamName, 
                    budget: customBudget // APPLY THE VARIABLE BUDGET HERE
                },
                { upsert: true }
            );
        }

        // Refresh UI
        const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
        const teams = await Team.find();
        io.emit('authorizedUsersList', users);
        io.emit('updateTeams', teams);
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ Captain ${userEmail} linked to ${teamName} with ${customBudget}L` });

    } catch (err) {
        socket.emit('errorMsg', "Failed to create user.");
    }
});

        // Refresh admin list
        const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
        io.emit('authorizedUsersList', users);
        io.emit('updateTeams', await Team.find());
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ User ${data.email} created successfully!` });
    } catch (err) { socket.emit('errorMsg', "User already exists or error occurred."); }
});
    socket.on('deleteAuthorizedUser', async (id) => {
    await User.findByIdAndDelete(id);
    const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
    socket.emit('authorizedUsersList', users);
});

    // 3. Verify OTP
    socket.on('verifyOTP', async ({ email, otp }) => {
        try {
            const user = await User.findOne({ 
                email, 
                otp, 
                otpExpires: { $gt: Date.now() } 
            });

            if (user) {
                user.isVerified = true;
                user.otp = undefined;
                await user.save();
                socket.emit('loginSuccess', { name: user.name, role: user.role, email: user.email });
            } else {
                socket.emit('errorMsg', "Invalid or Expired OTP");
            }
        } catch (err) {
            socket.emit('errorMsg', "Verification Error");
        }
    });

    // --- PREVIOUS AUCTION FUNCTIONS (UNTOUCHED) ---

    socket.on('addPlayer', async (data) => {
        try {
            const newPlayer = new Player({ ...data, strength: Number(data.strength), baseValue: Number(data.baseValue), division: Number(data.division), // NEW
            phone: Number(data.phone),
            imageUrl: data.imageUrl  
            });
            await newPlayer.save();
            io.emit('updatePlayers', await Player.find()); 
        } catch (err) { console.error(err); }
    });

    socket.on('startAuction', async ({ playerId, baseValue }) => {
    const player = await Player.findById(playerId);
    if (player) {
        auctionState = { 
            activePlayerId: player, 
            currentBid: baseValue, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 120,
            skippedTeams: [] // Reset for new player
        };
        io.emit('updateAuction', auctionState);
        startTimer();
    }
});

    socket.on('startFinalCall', () => {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        auctionState.isFinalCall = true;
        startTimer(); // This will now start the 30s sequence
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "⚠️ ADMIN HAS INITIATED THE FINAL CALL!" });
    }
});

    socket.on('placeBid', async ({ teamName, increment }) => {
    // 1. Check if they already skipped
    if (auctionState.skippedTeams.includes(teamName)) {
        return socket.emit('errorMsg', "You skipped this round!");
    }

    // 2. Check if they are already the highest bidder
    if (auctionState.highestBidder === teamName) {
        return socket.emit('errorMsg', "You are already the highest bidder!");
    }

    const team = await Team.findOne({ name: teamName });
    const newBid = auctionState.currentBid + increment;

    if (team && team.budget >= newBid) {
        auctionState.currentBid = newBid;
        auctionState.highestBidder = teamName;

        // --- NEW CODE ADDED HERE ---
        // If someone bids, we cancel the Final Call and return to normal timer
        auctionState.isFinalCall = false;
        auctionState.finalCallText = "";
        // ---------------------------

        startTimer(); // This will now reset to 60s because isFinalCall is false
        io.emit('updateAuction', auctionState);
    }
});

    
    socket.on('skipRound', ({ teamName }) => {
    if (!auctionState.skippedTeams.includes(teamName)) {
        auctionState.skippedTeams.push(teamName);
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `⚠️ ${teamName} has skipped this round.` 
        });
    }
});

    socket.on('sellPlayer', autoSellPlayer);
    socket.on('cancelAuction', () => {
        clearInterval(timerInterval);
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    });

    socket.on('addBonus', async ({ teamName, amount }) => {
        try {
            await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: Number(amount) } });
            io.emit('updateTeams', await Team.find());
            io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `✨ ${teamName} purse adjusted by ${amount}M!` });
        } catch (err) { console.error(err); }
    });
    // --- FORCE PURSE DEDUCTION (ADMIN ONLY) ---
socket.on('deductPurse', async ({ teamName, amount }) => {
    try {
        // Ensure the amount is treated as a negative number
        const deduction = -Math.abs(Number(amount));
        
        await Team.findOneAndUpdate(
            { name: teamName }, 
            { $inc: { budget: deduction } }
        );

        // Update all screens
        const updatedTeams = await Team.find();
        io.emit('updateTeams', updatedTeams);

        // Broadcast to chat with a Warning style
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `⚠️ PENALTY: ${teamName} purse has been forcefully reduced by ${Math.abs(amount)}M!` 
        });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Force deduction failed.");
    }
});
    // --- ADMIN TEAM/FRANCHISE MANAGEMENT ---

// 1. Create a New Team
socket.on('createNewTeam', async ({ name, budget }) => {
    try {
        const newTeam = new Team({ 
            name: name.trim(), 
            budget: Number(budget) 
        });
        await newTeam.save();
        
        // Broadcast updated list to all users
        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ Team [${name}] created with ${budget}M budget.` });
    } catch (err) {
        socket.emit('errorMsg', "Team already exists or error occurred.");
    }
});

// 2. Delete a Team
socket.on('deleteTeam', async (id) => {
    try {
        await Team.findByIdAndDelete(id);
        
        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        
        socket.emit('newMessage', { sender: "SYSTEM", text: "❌ Team removed from the database." });
    } catch (err) {
        socket.emit('errorMsg', "Failed to delete team.");
    }
});

    socket.on('sendMessage', async (data) => {
    // BLOCK GUESTS FROM SENDING
    if (data.role === 'guest') {
        return socket.emit('errorMsg', "Guests are not allowed to chat.");
    }

    try {
        await new Chat(data).save();
        io.emit('newMessage', data);
    } catch (err) {
        console.error("Chat Error:", err);
    }
});

    socket.on('deletePlayer', async (playerId) => {
        await Player.findByIdAndDelete(playerId);
        io.emit('updatePlayers', await Player.find()); 
    });
    // Add this inside your io.on('connection', ...) block
socket.on('updatePlayerImage', async ({ playerId, imageUrl }) => {
    try {
        await Player.findByIdAndUpdate(playerId, { imageUrl: imageUrl });
        
        // Refresh the list for everyone
        const updatedPlayers = await Player.find();
        io.emit('updatePlayers', updatedPlayers);
        
        // If this player is currently live, update the auction screen too
        if (auctionState.activePlayerId && auctionState.activePlayerId._id.toString() === playerId) {
            auctionState.activePlayerId.imageUrl = imageUrl;
            io.emit('updateAuction', auctionState);
        }
        
        socket.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "✅ Player image updated successfully!" });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Failed to update image");
    }
});
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));
