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
const ADMINS = [
    { email: "sarkaranubhav48@gmail.com", name: "Nexus Admin", pass: "admin123" }
];

const CAPTAINS = [
    { email: "riturajjj10@gmail.com", name: "Storm Hunters", pass: "roni123" },
    { email: "asheshchatterjee.2016@gmail.com", name: "UNDERDOG FC", pass: "ashesh123" },
    { email: "anishdgp0104@gmail.com", name: "FlameBorn Kings", pass: "anish123" },
    { email: "sunnyghoshdastidar506@gmail.com", name: "Wrath Of Wings", pass: "piyush123" },
    { email: "kunduarnab7439@gmail.com", name: "PANDAVA", pass: "arnab123" },
    { email: "pariasaikat94@gmail.com", name: "Destroyers", pass: "saikat123" },
    { email: "cjoy7970@gmail.com", name: "Madrid Warriors", pass: "joy123" },
    { email: "sammondal888@gmail.com", name: "Black Panthers FC", pass: "sam123" }
    
];

// --- AUTH UTILITIES ---
async function sendOTPEmail(email, otp) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Nexus Legends Verification Code";
    sendSmtpEmail.htmlContent = `<html><body><h1>Your OTP: ${otp}</h1><p>Use this code to verify your account.</p></body></html>`;
    sendSmtpEmail.sender = { "name": "Nexus Legends", "email": process.env.BREVO_SENDER_EMAIL };
    sendSmtpEmail.to = [{ "email": email }];
    return apiInstance.sendTransacEmail(sendSmtpEmail);
}

// --- AUTOMATIC TEAM SEEDING ---
const teamList = [
    { name: "Storm Hunters", budget: 2000 },
    { name: "UNDERDOG FC", budget: 2000 },
    { name: "FlameBorn Kings", budget: 2000 },
    { name: "Wrath Of Wings", budget: 2000 },
    { name: "PANDAVA", budget: 2000 },
    { name: "Destroyers", budget: 2000 },
    { name: "Madrid Warriors", budget: 2000 },
    { name: "Black Panthers FC", budget: 2000 }
];

async function seedTeams() {
    for (let t of teamList) {
        const exists = await Team.findOne({ name: t.name });
        if (!exists) {
            await new Team(t).save();
            console.log(`🌱 Seeded team: ${t.name}`);
        }
    }
}
seedTeams();

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
            soldTo: `${teamName} (${price}L)`
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
        const list = type === 'admin' ? ADMINS : CAPTAINS;
        const entry = list.find(u => u.email === email && u.pass === password);
        
        if (entry) {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            await User.findOneAndUpdate(
                { email },
                { 
                    name: entry.name, 
                    role: type, 
                    otp, 
                    otpExpires: Date.now() + 600000, 
                    isVerified: true 
                },
                { upsert: true }
            );
            await sendOTPEmail(email, otp);
            socket.emit('authStep', 'otp_verify');
        } else {
            socket.emit('errorMsg', "Invalid Authorized Credentials");
        }
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
            io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `✨ ${teamName} purse adjusted by ${amount}L!` });
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
            text: `⚠️ PENALTY: ${teamName} purse has been forcefully reduced by ${Math.abs(amount)}L!` 
        });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Force deduction failed.");
    }
});

    socket.on('sendMessage', async (data) => {
        // Simple security check: Only allow chat if user is verified (optional)
        await new Chat(data).save();
        io.emit('newMessage', data);
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
