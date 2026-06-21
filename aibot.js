require('dotenv').config(); 

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');

// Discord Bot 
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent // Discord Developer Portal'dan açtığın izin
    ]
});

// Gemini 
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// data logs of msgs
const chatHistories = new Map();

// her kullanıcının son mesaj zamanı (memory leak + inaktif sohbetleri temizlemek için)
const lastActive = new Map();


const DAILY_LIMIT = 200;
let dailyRequestCount = 0;
let resetTime = getNextMidnight();

function getNextMidnight() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.getTime();
}

function checkAndResetDailyCounter() {
    if (Date.now() >= resetTime) {
        dailyRequestCount = 0;
        resetTime = getNextMidnight();
    }
}

// memory leak
const INACTIVE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 saat

function cleanupInactiveSessions() {
    const now = Date.now();
    for (const [userId, last] of lastActive.entries()) {
        if (now - last > INACTIVE_TIMEOUT_MS) {
            chatHistories.delete(userId);
            lastActive.delete(userId);
        }
    }
}
setInterval(cleanupInactiveSessions, 30 * 60 * 1000); // her 30 dakikada bir kontrol et

// bots personality to here pls custom its for turkish
const BOT_PERSONALITY = `  
write what if you want IMPORTANT its for personality
`;

// 
client.once('ready', () => {
    console.log(`${client.user.tag} w login `);
    
    // do not change for cr
    client.user.setPresence({
        activities: [{ name: 'open source git: vedojar', type: ActivityType.Watching }],
        status: 'online',
    });
});

client.on('messageCreate', async (message) => {
    // ignore some msgs
    if (message.author.bot || !message.content) return;

    // id customizable
    const CHAT_CHANNEL_ID = "xxxxxxxxxxxx"; // change this for ur id

    let soraBilirsin = false;

    // msg w channel
    if (message.channel.id === CHAT_CHANNEL_ID) {
        soraBilirsin = true;
    } 
    // dm or @
    else if (message.mentions.has(client.user) || message.guild === null) {
        soraBilirsin = true;
    }

    // mute bot
    if (!soraBilirsin) return;

    // delete the @
    const cleanMessage = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!cleanMessage) return;

    // control 
    checkAndResetDailyCounter();
    if (dailyRequestCount >= DAILY_LIMIT) {
        await message.reply("My daily Gemini 2.5 flash quota has been used up, please try again later."); // customizable
        return;
    }

    // start typing
    await message.channel.sendTyping();

    const userId = message.author.id;
    lastActive.set(userId, Date.now());

    try {
        // log of msgs
        if (!chatHistories.has(userId)) {
            const session = ai.chats.create({
                model: 'gemini-2.5-flash-lite', // its best vers of gemini
                config: {
                    systemInstruction: BOT_PERSONALITY // personality
                }
            });
            chatHistories.set(userId, session);
        }

        // log
        const userChatSession = chatHistories.get(userId);

        dailyRequestCount++;

        // send msg to gemini 2.5 flash model
        const response = await userChatSession.sendMessage({
            message: cleanMessage
        });

        // control of discord 2000 
        let botReply = response.text;
        if (botReply.length > 2000) {
            botReply = botReply.substring(0, 1995) + "...";
        }

        // reply w/ gemini
        await message.reply(botReply);

    } catch (error) {
        console.error("Gemini entegrasyon hatası:", error);

        // 429 error
        if (error.status === 429) {
            // 
            dailyRequestCount = DAILY_LIMIT;
            await message.reply("My daily Gemini 2.5 flash quota has been used up, please try again later."); // customizable
        } else {
            await message.reply("please try again");  // custom
        }
    }
});

// startup command
client.login(process.env.DISCORD_TOKEN);
