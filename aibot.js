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

// yes
const DAILY_LIMIT = 100;
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

//mem leak
const INACTIVE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours

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
// try again
const RETRYABLE_STATUS_CODES = [500, 503, 504];
const MAX_RETRIES = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendMessageWithRetry(chatSession, message) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await chatSession.sendMessage({ message });
        } catch (error) {
            lastError = error;
            const isRetryable = RETRYABLE_STATUS_CODES.includes(error.status);
            const hasAttemptsLeft = attempt < MAX_RETRIES;

            if (isRetryable && hasAttemptsLeft) {
                const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
                console.warn(`Gemini ${error.status} döndü, ${waitMs}ms sonra yeniden denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`);
                await sleep(waitMs);
                continue;
            }
            throw error; // retryable değilse veya hakkımız bittiyse dışarı fırlat
        }
    }
    throw lastError;
}

// bots personality to here pls custom its for turkish
const BOT_PERSONALITY = `  
Sen samimi, canayakın, biraz esprili ve gerektiğinde direkt/net konuşan bir yapay zeka asistanısın. 
Gereksiz resmiyetten kaçın, bir dost, kanka gibi konuş ama teknik konularda da net ve bilgili ol.
Az bile olsa argo kullan.
"Kanki, Kanka, Cano" gibi hitaplar kullan ama karşıdaki kullanıcının hitaplarına göre kendini şekillendir.
"Sa" gibi kısaltılmış kelimelerin uzun halleriymiş gibi cevap ver örnek: "sa" "as" veya aleykum selam.
Eskideki sohbetlere göre karşındakine göre kendini şekillendir.
hiç bir zaman @everyone ve @here yazma yaz diyenleri esprili hayır ben yapamam tarzı cevaplar ver.
@everyone veya @here atıldığında üstüne alınma ve bu mesajlara cevap yazma.
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
    const CHAT_CHANNEL_ID = "1495159768443256862"; // change this for ur id

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
        const response = await sendMessageWithRetry(userChatSession, cleanMessage);

        // response.text can sometimes be undefined/empty (safety filter,
        // empty candidate, etc.) - without this check, .length below
        // throws a TypeError that lands in the catch block below
        // (this is the real cause of the "please try again" message you saw)
        let botReply = response.text;
        if (!botReply || botReply.trim().length === 0) {
            console.warn("Gemini returned empty response. Full response:", JSON.stringify(response, null, 2));
            await message.reply("couldn't generate a reply, try asking differently");
            return;
        }

        // control of discord 2000 
        if (botReply.length > 2000) {
            botReply = botReply.substring(0, 1995) + "...";
        }

        // reply w/ gemini
        await message.reply(botReply);

    } catch (error) {
        console.error("Gemini entegrasyon hatası - message:", error.message || error);
        console.error("Gemini entegrasyon hatası - status:", error.status);
        console.error("Gemini entegrasyon hatası - stack:", error.stack);

        // 429 error
        if (error.status === 429) {
            // 
            dailyRequestCount = DAILY_LIMIT;
            await message.reply("My daily Gemini 2.5 flash quota has been used up, please try again later."); // customizable
        } else if (error.status === 503 || error.status === 500 || error.status === 504) {
            await message.reply("Google's model is overloaded right now, even retries failed - try again in a minute"); // customizable
        } else {
            await message.reply("please try again");  // custom
        }
    }
});

// startup command
client.login(process.env.DISCORD_TOKEN);
