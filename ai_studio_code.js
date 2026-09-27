require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({
    origin: ["https://pes-park-official.vercel.app", "http://localhost:3000"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-api-key"]
}));

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
    name: { type: String, required: true },
    strength: { type: Number, default: 0 },
    cardType: { type: String, default: 'HIGHLIGHT' },
    baseValue: { type: Number, default: 2 },
    phone: { type: mongoose.Schema.Types.Mixed, default: "" },
    imageUrl: { type: String, default: "" },
    status: { type: String, default: 'Available' },
    soldTo: { type: String, default: '-' }
});

const teamSchema = new mongoose.Schema({ 
    name: String, 
    budget: Number,
    initialBudget: Number,
    maxCapacity: { type: Number, default: 10 },
    logoUrl: { type: String, default: "" }
});

const chatSchema = new mongoose.Schema({ 
    sender: String, role: String, text: String, timestamp: { type: Date, default: Date.now } 
});

const historySchema = new mongoose.Schema({
    playerName: String,
    price: Number,
    timestamp: { type: Date, default: Date.now }
});

const musicSchema = new mongoose.Schema({
    url: String,
    addedBy: String,
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const Chat = mongoose.model('Chat', chatSchema);
const History = mongoose.model('History', historySchema);
const Music = mongoose.model('Music', musicSchema);

// --- SAFETY SYNC: GRAPH HISTORY ---
async function syncPastSalesToGraph() {
    try {
        const soldPlayers = await Player.find({ status: 'Sold' });
        for (let p of soldPlayers) {
            const priceMatch = p.soldTo.match(/\((\d+)M\)/);
            const priceValue = priceMatch ? parseInt(priceMatch[1]) : 0;
            const alreadyInHistory = await History.findOne({ playerName: p.name });
            
            if (!alreadyInHistory && priceValue > 0) {
                await History.create({ playerName: p.name, price: priceValue });
            }
        }
    } catch (e) {
        console.error("Sync Graph Error:", e);
    }
}
syncPastSalesToGraph();

// --- AUTH UTILITIES ---
async function sendOTPEmail(email, otp) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `🔑 ${otp} is your NEXUS LEGENDS Access Code`;
    sendSmtpEmail.htmlContent = `
        <div style="font-family: Arial, sans-serif; background-color: #0a0f16; color: #ffffff; padding: 40px; text-align: center; border-radius: 20px;">
            <h1 style="color: #00e5ff; margin-bottom: 10px;">PES PARK</h1>
            <p style="color: #64748b; font-size: 14px; text-transform: uppercase; letter-spacing: 2px;">Identity Verification</p>
            <hr style="border: 0; border-top: 1px solid #1e293b; margin: 20px 0;">
            <p style="font-size: 16px;">Use the following code to access the Auction Arena:</p>
            <div style="background: #1e293b; padding: 20px; border-radius: 10px; display: inline-block; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 10px; color: #eaff00;">${otp}</span>
            </div>
        </div>
    `;
    sendSmtpEmail.sender = { "name": "PES PARK ARENA", "email": process.env.BREVO_SENDER_EMAIL };
    sendSmtpEmail.to = [{ "email": email }];
    return apiInstance.sendTransacEmail(sendSmtpEmail);
}

// --- MASTER ADMIN SETUP ---
async function createMasterAdmin() {
    try {
        const adminEmail = "sarkaranubhav48@gmail.com";
        const hashedPassword = await bcrypt.hash("admin123", 10);
        await User.findOneAndUpdate(
            { email: adminEmail },
            { name: "Nexus Master Admin", email: adminEmail, password: hashedPassword, role: "admin", isVerified: true },
            { upsert: true, new: true }
        );
        console.log("👑 Master Admin Account Synced");
    } catch (e) {
        console.error("Master Admin Error:", e);
    }
}
createMasterAdmin();

// --- HTTP ROUTES ---
const DATA_SYNC_KEY = "NEXUS_SECRET_789";

app.get('/reset-teams', async (req, res) => {
    try {
        await Team.updateMany({}, { $set: { budget: 2000 } });
        res.send("✅ All budgets reset to 2000L!");
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/export-results', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== DATA_SYNC_KEY) return res.status(403).json({ error: "Access Denied: Invalid Sync Key" });

    try {
        const players = await Player.find();
        const teams = await Team.find();

        const formattedData = players.map(p => {
            let teamName = "Free Agent";
            let soldPrice = 0;
            if (p.status === 'Sold' && p.soldTo.includes('(')) {
                const parts = p.soldTo.split('(');
                teamName = parts[0].trim();
                soldPrice = parseInt(parts[1].replace(')',''));
            }
            return {
                nexus_id: p._id, name: p.name, strength: p.strength, tier: p.cardType,
                whatsapp: p.phone, image: p.imageUrl, status: p.status, assigned_to: teamName, transfer_fee: soldPrice
            };
        });

        res.json({
            tournament_season: "2026-27", total_players: players.length,
            franchises: teams.map(t => ({ name: t.name, logo: t.logoUrl, remaining_purse: t.budget })),
            players: formattedData
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sync/verify-captain', async (req, res) => {
    try {
        const { email, password, selectedTeam } = req.body;
        const cleanEmail = email.trim().toLowerCase();
        const user = await User.findOne({ email: cleanEmail, role: 'captain' });
        
        if (!user || user.name !== selectedTeam) {
            return res.status(401).json({ success: false, message: "Authentication failed or team mismatch" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Incorrect Password" });

        const team = await Team.findOne({ name: selectedTeam });
        const squad = await Player.find({ soldTo: { $regex: new RegExp('^' + selectedTeam) } });

        res.json({ success: true, teamName: user.name, purse: team ? team.budget : 0, logo: team ? team.logoUrl : "", squad });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- AUCTION ENGINE STATE ---
let auctionState = { 
    activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', 
    timeLeft: 20, skippedTeams: [], isFinalCall: false, finalCallText: "", isHidden: false
};
let timerInterval = null;
let focusedCaptains = new Set();
let slideshowState = { active: false, currentIndex: 0, players: [] };
let slideshowInterval = null;

function getFinalCallText(seconds) {
    if (seconds > 15) return "Are there any further bids?";
    if (seconds > 10) return "For the first time...";
    if (seconds > 5) return "For the second time...";
    if (seconds > 3) return "Going once...";
    if (seconds > 2) return "Going twice...";
    return "SOLD!";
}

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timeLeft = auctionState.isFinalCall ? 17 : 20; 
    
    timerInterval = setInterval(async () => {
        auctionState.timeLeft--;
        if (auctionState.isFinalCall) auctionState.finalCallText = getFinalCallText(auctionState.timeLeft);
        
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
        const player = auctionState.activePlayerId;

        await Player.findByIdAndUpdate(player._id, { status: 'Sold', soldTo: `${teamName} (${price}M)` });
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: -price } });
        await History.create({ playerName: player.name, price: price });
        
        io.emit('celebrateSold', { player, teamName, price });
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        io.emit('updateAuction', auctionState);
        await broadcastStats();
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `🔴 SOLD! ${teamName} bought ${player.name} for ${price}M.` });
    }
}

async function getStatsObject() {
    const players = await Player.find();
    const countTier = (t) => players.filter(p => p.cardType && p.cardType.toLowerCase() === t.toLowerCase()).length;
    return {
        total: players.length,
        sold: players.filter(p => p.status === 'Sold').length,
        unsold: players.filter(p => p.status === 'Unsold').length,
        tiers: { bigtime: countTier('BIG TIME'), epic: countTier('EPIC'), showtime: countTier('SHOWTIME'), highlight: countTier('HIGHLIGHT') }
    };
}

async function broadcastStats() {
    try {
        const stats = await getStatsObject();
        io.emit('updateGlobalStats', stats);
    } catch (err) { console.error(err); }
}

// --- SOCKET CONNECTION & ALL RESTORED FUNCTIONS ---
io.on('connection', async (socket) => {
    const [players, teams, chats, stats, history, customMusic] = await Promise.all([
        Player.find(), Team.find(), Chat.find().sort({ timestamp: 1 }).limit(50),
        getStatsObject(), History.find().sort({ timestamp: 1 }).limit(70), Music.find()
    ]);

    socket.emit('initialData', { players, teams, chats, state: auctionState, stats, history, customMusic: customMusic.map(m => m.url) });

    // Authentication
    socket.on('specialSignIn', async ({ email, password, type }) => {
        try {
            const cleanEmail = email.trim().toLowerCase();
            const user = await User.findOne({ email: cleanEmail, role: type.trim().toLowerCase() });
            
            if (!user) return socket.emit('errorMsg', "Account not found for this role.");

            if (await bcrypt.compare(password, user.password)) {
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                user.otp = otp;
                user.otpExpires = Date.now() + 600000; 
                await user.save();
                await sendOTPEmail(cleanEmail, otp);
                socket.emit('authStep', 'otp_verify');
            } else {
                socket.emit('errorMsg', "Incorrect Password.");
            }
        } catch (e) { socket.emit('errorMsg', "Auth Error."); }
    });

    socket.on('guestSignIn', () => {
        socket.emit('guestLoginSuccess', { name: "Guest Viewer", role: "guest" });
    });

    socket.on('verifyOTP', async ({ email, otp }) => {
        const user = await User.findOne({ email, otp, otpExpires: { $gt: Date.now() } });
        if (user) {
            user.isVerified = true;
            user.otp = undefined;
            await user.save();
            socket.emit('loginSuccess', { name: user.name, role: user.role, email: user.email });
        } else {
            socket.emit('errorMsg', "Invalid or Expired OTP");
        }
    });

    socket.on('getAuthorizedUsers', async () => {
        const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
        socket.emit('authorizedUsersList', users);
    });

    // Player Management
    socket.on('addPlayer', async (data) => {
        try {
            const newPlayer = new Player({ 
                name: data.name ? data.name.trim() : "Unknown Legend",
                strength: Number(data.strength) || 0,
                cardType: data.cardType || "HIGHLIGHT",
                baseValue: Number(data.baseValue) || 2,
                phone: data.phone || "",
                imageUrl: data.imageUrl || "",
                status: 'Available',
                soldTo: '-'
            });
            await newPlayer.save();
            await broadcastStats();
            io.emit('updatePlayers', await Player.find());
            socket.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `✅ Added player: ${newPlayer.name}` });
        } catch (err) {
            socket.emit('errorMsg', "Failed to add player.");
        }
    });

    socket.on('bulkAddPlayers', async (playersArray) => {
        try {
            const formatted = playersArray.map(p => ({
                name: p.name || "Unknown",
                strength: Number(p.strength) || 0,
                cardType: p.cardType || "HIGHLIGHT",
                baseValue: Number(p.baseValue) || 2,
                phone: p.phone || "",
                imageUrl: p.imageUrl || "",
                status: 'Available',
                soldTo: '-'
            }));
            await Player.insertMany(formatted);
            await broadcastStats();
            io.emit('updatePlayers', await Player.find());
            socket.emit('bulkImportSuccess', `Successfully imported ${formatted.length} players!`);
        } catch (err) {
            socket.emit('errorMsg', "Bulk Import Failed: " + err.message);
        }
    });

    socket.on('updatePlayerImage', async ({ playerId, imageUrl }) => {
        try {
            await Player.findByIdAndUpdate(playerId, { imageUrl });
            io.emit('updatePlayers', await Player.find());
            if (auctionState.activePlayerId && auctionState.activePlayerId._id.toString() === playerId) {
                auctionState.activePlayerId.imageUrl = imageUrl;
                io.emit('updateAuction', auctionState);
            }
        } catch (err) { socket.emit('errorMsg', "Image update failed"); }
    });

    socket.on('deletePlayer', async (id) => {
        await Player.findByIdAndDelete(id);
        await broadcastStats();
        io.emit('updatePlayers', await Player.find());
    });

    // Auction Core
    socket.on('startAuction', async ({ playerId, baseValue, isHidden }) => { 
        const player = await Player.findById(playerId);
        if (player) {
            await Player.findByIdAndUpdate(playerId, { status: 'Available', soldTo: '-' });
            auctionState = { 
                activePlayerId: player, currentBid: baseValue, highestBidder: 'No Bids Yet', 
                timeLeft: 20, skippedTeams: [], isFinalCall: false, finalCallText: "", isHidden: isHidden || false 
            };
            io.emit('updatePlayers', await Player.find());
            io.emit('updateAuction', auctionState);
            startTimer();
            await broadcastStats();
        }
    });

    socket.on('startFinalCall', () => {
        if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
            auctionState.isFinalCall = true;
            startTimer();
            io.emit('updateAuction', auctionState);
            io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "⚠️ FINAL CALL INITIATED!" });
        }
    });

    socket.on('revealPlayer', () => {
        auctionState.isHidden = false;
        io.emit('updateAuction', auctionState);
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        if (auctionState.skippedTeams.includes(teamName) || auctionState.highestBidder === teamName) return;
        const team = await Team.findOne({ name: teamName });
        const playerCount = await Player.countDocuments({ soldTo: new RegExp('^' + teamName) });

        if (playerCount >= team.maxCapacity) return socket.emit('errorMsg', `🚫 Squad full! Limit is ${team.maxCapacity}`);

        const newBid = auctionState.currentBid + increment;
        if (team && team.budget >= newBid) {
            auctionState.currentBid = newBid;
            auctionState.highestBidder = teamName;
            auctionState.isFinalCall = false;
            auctionState.finalCallText = "";
            startTimer();
            io.emit('updateAuction', auctionState);
        }
    });

    socket.on('skipRound', ({ teamName }) => {
        if (!auctionState.skippedTeams.includes(teamName)) {
            auctionState.skippedTeams.push(teamName);
            io.emit('updateAuction', auctionState);
        }
    });

    socket.on('sellPlayer', autoSellPlayer);
    
    socket.on('markUnsold', async () => {
        if (auctionState.activePlayerId) {
            await Player.findByIdAndUpdate(auctionState.activePlayerId._id, { status: 'Unsold', soldTo: 'UNSOLD' });
            clearInterval(timerInterval);
            auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
            io.emit('updatePlayers', await Player.find());
            io.emit('updateAuction', auctionState);
            await broadcastStats();
        }
    });

    socket.on('cancelAuction', () => {
        clearInterval(timerInterval);
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    });

    // Franchise & Admin Management
    socket.on('createNewTeam', async ({ name, budget }) => {
        const teamName = name.trim();
        const teamBudget = Number(budget);
        await Team.findOneAndUpdate({ name: teamName }, { name: teamName, budget: teamBudget, initialBudget: teamBudget }, { upsert: true });
        io.emit('updateTeams', await Team.find());
    });

    socket.on('deleteTeam', async (id) => {
        await Team.findByIdAndDelete(id);
        io.emit('updateTeams', await Team.find());
    });

    socket.on('updateTeamLogo', async ({ teamId, logoUrl }) => {
        await Team.findByIdAndUpdate(teamId, { logoUrl });
        io.emit('updateTeams', await Team.find());
    });

    socket.on('setTeamCapacity', async ({ teamId, capacity }) => {
        await Team.findByIdAndUpdate(teamId, { maxCapacity: Number(capacity) });
        io.emit('updateTeams', await Team.find());
        await broadcastStats();
    });

    socket.on('addBonus', async ({ teamName, amount }) => {
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: Number(amount) } });
        io.emit('updateTeams', await Team.find());
    });

    socket.on('deductPurse', async ({ teamName, amount }) => {
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: -Math.abs(Number(amount)) } });
        io.emit('updateTeams', await Team.find());
    });

    socket.on('resetPurse', async ({ teamName }) => {
        const team = await Team.findOne({ name: teamName });
        if (team) {
            team.budget = team.initialBudget;
            await team.save();
            io.emit('updateTeams', await Team.find());
        }
    });

    socket.on('adminForceAssign', async ({ playerId, teamName, price }) => {
        const player = await Player.findById(playerId);
        if (!player) return;
        const soldPrice = Number(price);
        await Player.findByIdAndUpdate(playerId, { status: 'Sold', soldTo: `${teamName} (${soldPrice}M)` });
        await History.create({ playerName: player.name, price: soldPrice });
        io.emit('celebrateSold', { player, teamName, price: soldPrice });
        io.emit('updatePlayers', await Player.find());
        await broadcastStats();
    });

    socket.on('reduceSquadCount', async ({ teamName, count }) => {
        const playersToRelease = await Player.find({ soldTo: { $regex: new RegExp('^' + teamName) } }).sort({ _id: -1 }).limit(Number(count));
        for (let p of playersToRelease) {
            await Player.findByIdAndUpdate(p._id, { status: 'Available', soldTo: '-' });
        }
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        await broadcastStats();
    });

    socket.on('createNewUser', async (data) => {
        const hashedPassword = await bcrypt.hash(data.password, 10);
        await User.findOneAndUpdate(
            { email: data.email.trim().toLowerCase() },
            { name: data.teamName.trim(), email: data.email.trim().toLowerCase(), password: hashedPassword, role: data.role.trim().toLowerCase(), isVerified: true },
            { upsert: true }
        );
        if (data.role === 'captain') {
            await Team.findOneAndUpdate(
                { name: data.teamName.trim() },
                { name: data.teamName.trim(), budget: Number(data.budget) || 2000, initialBudget: Number(data.budget) || 2000 },
                { upsert: true }
            );
        }
        io.emit('authorizedUsersList', await User.find({ role: { $ne: 'visitor' } }).select('-password -otp'));
        io.emit('updateTeams', await Team.find());
    });

    socket.on('deleteAuthorizedUser', async (id) => {
        await User.findByIdAndDelete(id);
        io.emit('authorizedUsersList', await User.find({ role: { $ne: 'visitor' } }).select('-password -otp'));
    });

    // Radio & Music
    socket.on('addMusicTrack', async (url) => {
        if (!url.startsWith('http')) return;
        await new Music({ url: url.trim() }).save();
        io.emit('newTrackAdded', url.trim());
    });

    // Communication & Reactions
    socket.on('sendMessage', async (data) => {
        if (data.role === 'admin' || data.role === 'captain') {
            await new Chat(data).save();
            io.emit('newMessage', data);
        }
    });

    socket.on('public_msg_send', (data) => {
        io.emit('public_msg_receive', { sender: data.sender, text: data.text });
    });

    socket.on('sendReaction', (emoji) => io.emit('newReaction', emoji));
    socket.on('public_reaction_send', (emoji) => io.emit('public_reaction_receive', emoji));

    // Reset Controls
    socket.on('hardResetDatabase', async () => {
        await Player.deleteMany({});
        await Team.deleteMany({});
        await Chat.deleteMany({});
        await User.deleteMany({ email: { $ne: "sarkaranubhav48@gmail.com" } });
        io.emit('updatePlayers', []);
        io.emit('updateTeams', []);
    });

    socket.on('clearOnlyPlayers', async () => {
        await Player.deleteMany({});
        io.emit('updatePlayers', []);
        await broadcastStats();
    });

    // Ghost Watch / Focus
    socket.on('updateFocus', (isFocused) => {
        if (isFocused) focusedCaptains.add(socket.id);
        else focusedCaptains.delete(socket.id);
        io.emit('ghostWatchCount', focusedCaptains.size);
    });

    socket.on('disconnect', () => {
        focusedCaptains.delete(socket.id);
        io.emit('ghostWatchCount', focusedCaptains.size);
    });

    // Slideshow Showcase
    socket.on('toggleSlideshow', async (shouldStart) => {
        if (shouldStart) {
            const unsoldPlayers = await Player.find({ status: 'Unsold' });
            if (unsoldPlayers.length === 0) return;
            slideshowState = { active: true, currentIndex: 0, players: unsoldPlayers };
            io.emit('updateSlideshow', slideshowState);

            clearInterval(slideshowInterval);
            slideshowInterval = setInterval(() => {
                slideshowState.currentIndex = (slideshowState.currentIndex + 1) % slideshowState.players.length;
                io.emit('updateSlideshow', slideshowState);
            }, 5000);
        } else {
            clearInterval(slideshowInterval);
            slideshowState = { active: false, currentIndex: 0, players: [] };
            io.emit('updateSlideshow', slideshowState);
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log("🚀 Server running with 100% restored features"));