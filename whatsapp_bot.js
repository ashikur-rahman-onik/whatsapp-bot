/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   সবুজ কম্পিউটার্স — WhatsApp Bot (Pro Edition)    ║
 * ║   Telegram Bot থেকে রূপান্তরিত                      ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Features:
 *  - Inline menu (buttons) via whatsapp-web.js
 *  - Gemini AI chat (multi-turn history)
 *  - Firebase Realtime DB (due/attendance/receipt/account linking)
 *  - Admin commands: broadcast, add_notice, delete_notice, verify_student, stats
 *  - Rate limiting
 *  - Admin reply forwarding (reply to forwarded messages)
 *
 * Setup:
 *  1. npm install whatsapp-web.js @google/genai axios qrcode-terminal
 *  2. Set environment variables (see below)
 *  3. node whatsapp_bot.js  → scan QR code with your WhatsApp
 */

const { Client, LocalAuth, Buttons, List, MessageMedia } = require('whatsapp-web.js');
const qrcode   = require('qrcode-terminal');
const axios    = require('axios');
const { GoogleGenAI } = require('@google/genai');

// ──────────────────────────────────────────────
// ⚙️ Environment & Constants
// ──────────────────────────────────────────────
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY  || '';
const ADMIN_PHONE     = process.env.ADMIN_PHONE     || ''; // e.g. "8801724084350@c.us"
const FIREBASE_URL    = process.env.FIREBASE_URL    || 'https://sabuj-computers-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

// Rate limiting config
const RATE_LIMIT_CALLS  = 5;   // max messages
const RATE_LIMIT_PERIOD = 30;  // per N seconds

const MAX_HISTORY_TURNS = 6;

// ──────────────────────────────────────────────
// 🤖 Gemini AI Setup
// ──────────────────────────────────────────────
let aiClient = null;
if (GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log('✅ Gemini AI client initialized.');
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant for 'Sabuj Computers Training Center' (সবুজ কম্পিউটার ট্রেনিং সেন্টার), located at Tamaltala Bazar, Bagatipara, Natore, Bangladesh. Always respond in polite, friendly Bengali. Always greet with 'আসসালামু আলাইকুম' — never use 'নমস্কার'. Office hours: Sat–Thu 9:00 AM–1:30 PM & 4:00 PM–8:30 PM (Friday closed). Courses: (1) Foundation Course — 6 months, ৳3500. (2) BTEB Course — 6 months, ৳4500 (Govt approved). Phone: 01724-084350. Email: sssabuj007@gmail.com. Website: https://sabujcomputers.pro.bd. Keep answers concise and helpful. If the user asks about their fee, attendance, or receipt, tell them to use !due, !attendance, or !receipt after linking their account via the 'অ্যাকাউন্ট লিঙ্ক করুন' option. Do not make up information. If you don't know something, say so politely.`;

// ──────────────────────────────────────────────
// 🗄️ Firebase Helpers
// ──────────────────────────────────────────────
function authParam() {
    return FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
}

async function getDb(path) {
    try {
        const url = `${FIREBASE_URL}/${path}.json${authParam()}`;
        const res = await axios.get(url, { timeout: 8000 });
        return res.data;
    } catch (e) {
        console.error(`GET error [${path}]:`, e.message);
        return null;
    }
}

async function putDb(path, data) {
    try {
        const url = `${FIREBASE_URL}/${path}.json${authParam()}`;
        const res = await axios.put(url, data, { timeout: 8000 });
        return res.data;
    } catch (e) {
        console.error(`PUT error [${path}]:`, e.message);
        return null;
    }
}

async function patchDb(path, data) {
    try {
        const url = `${FIREBASE_URL}/${path}.json${authParam()}`;
        const res = await axios.patch(url, data, { timeout: 8000 });
        return res.data;
    } catch (e) {
        console.error(`PATCH error [${path}]:`, e.message);
        return null;
    }
}

async function deleteDb(path) {
    try {
        const url = `${FIREBASE_URL}/${path}.json${authParam()}`;
        const res = await axios.delete(url, { timeout: 8000 });
        return res.status === 200;
    } catch (e) {
        console.error(`DELETE error [${path}]:`, e.message);
        return false;
    }
}

function nowStr() {
    return new Date().toLocaleString('en-BD', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
}

function nowTs() {
    return Math.floor(Date.now() / 1000);
}

// ──────────────────────────────────────────────
// 🛡️ Security Helpers
// ──────────────────────────────────────────────
const rateLimitStore = new Map(); // chatId -> [timestamps]

function isAdmin(chatId) {
    if (!ADMIN_PHONE) return false;
    return chatId === ADMIN_PHONE;
}

function isRateLimited(chatId) {
    const now = Date.now() / 1000;
    let calls = (rateLimitStore.get(chatId) || []).filter(t => now - t < RATE_LIMIT_PERIOD);
    if (calls.length >= RATE_LIMIT_CALLS) return true;
    calls.push(now);
    rateLimitStore.set(chatId, calls);
    return false;
}

// ──────────────────────────────────────────────
// 💬 User State Storage (in-memory, per session)
// ──────────────────────────────────────────────
const userState    = new Map(); // chatId -> { awaiting, chatHistory, pendingReplyTo }

function getState(chatId) {
    if (!userState.has(chatId)) userState.set(chatId, { awaiting: '', chatHistory: [] });
    return userState.get(chatId);
}

// ──────────────────────────────────────────────
// 📋 Menu Text (WhatsApp uses text-based menus)
// ──────────────────────────────────────────────
function mainMenuText() {
    return (
        `🌿 *সবুজ কম্পিউটার্সে আপনাকে স্বাগতম!*\n\n` +
        `বাগাতিপাড়া, নাটোরের সেরা BTEB অনুমোদিত কম্পিউটার প্রশিক্ষণ কেন্দ্র।\n\n` +
        `আমি একটি স্মার্ট AI বট। স্বাভাবিক ভাষায় কথা বললেও আমি বুঝতে পারব।\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 *মেনু (নিচের কমান্ড টাইপ করুন):*\n\n` +
        `1️⃣ !courses — কোর্সসমূহ\n` +
        `2️⃣ !fees — ফি তথ্য\n` +
        `3️⃣ !admission — ভর্তি তথ্য\n` +
        `4️⃣ !results — ফলাফল যাচাই\n` +
        `5️⃣ !notice — নোটিশ বোর্ড\n` +
        `6️⃣ !contact — যোগাযোগ\n` +
        `7️⃣ !link — অ্যাকাউন্ট লিঙ্ক করুন\n` +
        `8️⃣ !due — বকেয়া ফি\n` +
        `9️⃣ !attendance — উপস্থিতি\n` +
        `🔟 !receipt — পেমেন্ট রসিদ\n` +
        `🔁 !unlink — অ্যাকাউন্ট আনলিঙ্ক\n` +
        `🎧 !admin — অ্যাডমিনের সাথে কথা বলুন\n` +
        `❓ !help — সাহায্য\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🌐 ওয়েবসাইট: https://sabujcomputers.pro.bd\n` +
        `📞 ফোন: 01724-084350`
    );
}

// ──────────────────────────────────────────────
// 🚀 WhatsApp Client Setup
// ──────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

client.on('qr', qr => {
    console.log('\n📱 QR কোড স্ক্যান করুন WhatsApp দিয়ে:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot চালু হয়েছে! (সবুজ কম্পিউটার্স)');
});

client.on('auth_failure', () => {
    console.error('❌ Authentication failed! session মুছে আবার চেষ্টা করুন।');
});

// ──────────────────────────────────────────────
// 📨 Main Message Handler
// ──────────────────────────────────────────────
client.on('message', async (msg) => {
    // Ignore group messages (optional — remove this to support groups)
    if (msg.from.endsWith('@g.us')) return;

    const chatId = msg.from;
    const text   = (msg.body || '').trim();
    const state  = getState(chatId);

    // Skip status messages
    if (chatId === 'status@broadcast') return;

    // ── Rate limit (skip for admin) ──
    if (!isAdmin(chatId) && isRateLimited(chatId)) {
        await msg.reply('⏳ একটু থামুন! অনেক দ্রুত মেসেজ পাঠাচ্ছেন। কিছুক্ষণ পর আবার চেষ্টা করুন।');
        return;
    }

    // ── Admin reply forwarding ──
    // Admin replies to a forwarded message that contains [CHATID:xxxxxxxx]
    if (isAdmin(chatId) && msg.hasQuotedMsg) {
        const quoted = await msg.getQuotedMessage();
        const match  = (quoted.body || '').match(/\[CHATID:(\d+@c\.us)\]/);
        if (match) {
            const targetId = match[1];
            try {
                await client.sendMessage(targetId, `🎧 *অ্যাডমিনের রিপ্লাই:*\n\n${text}`);
                await msg.reply('✅ রিপ্লাই সফলভাবে পাঠানো হয়েছে।');
            } catch (e) {
                await msg.reply(`❌ রিপ্লাই পাঠানো যায়নি: ${e.message}`);
            }
            return;
        }
    }

    // ── State: Account Linking ──
    if (state.awaiting === 'link_reg') {
        await handleLinkAccount(msg, chatId, text, state);
        return;
    }

    // ── State: Talk to Admin ──
    if (state.awaiting === 'talk_admin') {
        await handleTalkAdmin(msg, chatId, text, state);
        return;
    }

    // ── Commands ──
    const cmd = text.toLowerCase().split(' ')[0];

    switch (cmd) {
        case '!start':
        case '!menu':
        case '!help':
            await msg.reply(cmd === '!help' ? helpText() : mainMenuText());
            break;

        case '!courses':
            await handleCourses(msg);
            break;

        case '!fees':
            await msg.reply(feesText());
            break;

        case '!admission':
            await msg.reply(admissionText());
            break;

        case '!results':
            await msg.reply(
                `🏆 *ফলাফল ও সার্টিফিকেট যাচাই*\n\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `আপনার রেজিস্ট্রেশন নম্বর দিয়ে অনলাইনে যাচাই করুন:\n\n` +
                `🔗 https://sabujcomputers.pro.bd/verify.html`
            );
            break;

        case '!notice':
            await handleNotice(msg);
            break;

        case '!contact':
            await msg.reply(contactText());
            break;

        case '!link':
            state.awaiting = 'link_reg';
            await msg.reply(
                `🔗 *অ্যাকাউন্ট লিঙ্ক করুন*\n\n` +
                `আপনার *ফোন নম্বর* অথবা *রেজিস্ট্রেশন নম্বর* টাইপ করে সেন্ড করুন:\n\n` +
                `_(উদাহরণ: 01724084350 বা SC-2024-001)_`
            );
            break;

        case '!due':
            await handleDue(msg, chatId);
            break;

        case '!attendance':
            await handleAttendance(msg, chatId);
            break;

        case '!receipt':
            await handleReceipt(msg, chatId);
            break;

        case '!unlink':
            await handleUnlink(msg, chatId);
            break;

        case '!admin':
            state.awaiting = 'talk_admin';
            await msg.reply(
                `🎧 *সরাসরি অ্যাডমিনের সাথে কথা বলুন*\n\n` +
                `আপনার প্রশ্ন বা মেসেজটি এখন টাইপ করে সেন্ড করুন।\n` +
                `অ্যাডমিন কিছুক্ষণের মধ্যে রিপ্লাই দেবেন। ⏳`
            );
            break;

        // ── Admin Commands ──
        case '!broadcast':
            await handleBroadcast(msg, chatId, text);
            break;

        case '!add_notice':
            await handleAddNotice(msg, chatId, text);
            break;

        case '!delete_notice':
            await handleDeleteNotice(msg, chatId, text);
            break;

        case '!verify_student':
            await handleVerifyStudent(msg, chatId, text);
            break;

        case '!stats':
            await handleStats(msg, chatId);
            break;

        default:
            // ── Gemini AI (free text) ──
            if (!text.startsWith('!') && aiClient) {
                await handleAI(msg, chatId, text, state);
            } else if (text.startsWith('!')) {
                await msg.reply(
                    `❓ কমান্ড বোঝা যায়নি। *!help* টাইপ করুন সব কমান্ড দেখতে।`
                );
            } else {
                await msg.reply(
                    `আমি বুঝতে পারিনি। *!menu* টাইপ করুন মেনু দেখতে।`
                );
            }
    }
});

// ──────────────────────────────────────────────
// 📦 Feature Handlers
// ──────────────────────────────────────────────

async function handleCourses(msg) {
    const courses = await getDb('sabuj/courses');
    let text = `🎓 *আমাদের কোর্সসমূহ*\n\n━━━━━━━━━━━━━━━━━━\n`;

    if (courses && typeof courses === 'object') {
        let i = 1;
        for (const [, c] of Object.entries(courses)) {
            text += (
                `${i}️⃣ *${c.name || 'কোর্স'}*\n` +
                `   ✅ মেয়াদ: ${c.duration || 'N/A'}\n` +
                `   ✅ ফি: ৳${c.fee || 'N/A'}\n` +
                `   ✅ সার্টিফিকেট: ${c.cert || 'N/A'}\n\n`
            );
            i++;
        }
    } else {
        text += (
            `1️⃣ *ফাউন্ডেশন কোর্স*\n` +
            `   ✅ মেয়াদ: ৬ মাস\n` +
            `   ✅ ফি: ৳৩,৫০০\n` +
            `   ✅ বিষয়: Basic Computer, MS Office, Internet\n` +
            `   ✅ সার্টিফিকেট: নিজস্ব\n\n` +
            `2️⃣ *BTEB কোর্স*\n` +
            `   ✅ মেয়াদ: ৬ মাস\n` +
            `   ✅ ফি: ৳৪,৫০০\n` +
            `   ✅ সার্টিফিকেট: সরকারি (BTEB অনুমোদিত)\n` +
            `   ✅ চাকরির বাজারে ১০০% গ্রহণযোগ্য\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📞 ভর্তির জন্য: 01724-084350`
        );
    }
    await msg.reply(text);
}

function feesText() {
    return (
        `💰 *ফি সংক্রান্ত তথ্য*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🎓 *ফাউন্ডেশন কোর্স:*\n` +
        `   🏷️ কোর্স ফি: *৳৩,৫০০*\n` +
        `   _(বেসিক কম্পিউটার, এমএস অফিস, ইন্টারনেট)_\n\n` +
        `🏆 *BTEB কোর্স:*\n` +
        `   🏷️ কোর্স ফি: *৳৪,৫০০*\n` +
        `   _(সরকারি সনদপ্রাপ্ত, চাকরির বাজারে ১০০% গ্রহণযোগ্য)_\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 বিস্তারিত জানতে: 📞 01724-084350`
    );
}

function admissionText() {
    return (
        `📝 *ভর্তি তথ্য*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🏫 *সবুজ কম্পিউটার ট্রেনিং সেন্টার*\n` +
        `📍 তমালতলা বাজার, বাগাতিপাড়া, নাটোর\n\n` +
        `📋 *ভর্তির জন্য যা লাগবে:*\n` +
        `   • জাতীয় পরিচয়পত্র / জন্ম নিবন্ধন\n` +
        `   • ১ কপি পাসপোর্ট সাইজ ছবি\n` +
        `   • শিক্ষাগত সনদ (প্রযোজ্য ক্ষেত্রে)\n\n` +
        `⏰ *অফিস সময়:*\n` +
        `   সকাল ৯:০০ — দুপুর ১:৩০\n` +
        `   বিকেল ৪:০০ — রাত ৮:৩০\n` +
        `   _(শুক্রবার বন্ধ)_\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📞 01724-084350\n` +
        `📝 অনলাইন ভর্তি ফরম: https://sabujcomputers.pro.bd/admission-form.html`
    );
}

function contactText() {
    return (
        `📞 *যোগাযোগ করুন*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🏫 *সবুজ কম্পিউটার ট্রেনিং সেন্টার*\n\n` +
        `📞 ফোন: 01724-084350\n` +
        `✉️ ইমেইল: sssabuj007@gmail.com\n` +
        `📍 তমালতলা বাজার, বাগাতিপাড়া, নাটোর\n\n` +
        `⏰ সেবার সময়:\n` +
        `   শনি–বৃহস্পতি: সকাল ৯:০০ — রাত ৮:৩০\n` +
        `   _(শুক্রবার বন্ধ)_\n\n` +
        `💬 WhatsApp: https://wa.me/8801724084350`
    );
}

function helpText() {
    return (
        `📖 *ব্যবহারযোগ্য কমান্ডসমূহ*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 *শিক্ষার্থী কমান্ড:*\n` +
        `🔹 !menu — মূল মেনু\n` +
        `🔹 !courses — কোর্স তালিকা\n` +
        `🔹 !fees — ফি তথ্য\n` +
        `🔹 !admission — ভর্তি তথ্য\n` +
        `🔹 !notice — নোটিশ বোর্ড\n` +
        `🔹 !contact — যোগাযোগ\n` +
        `🔹 !link — অ্যাকাউন্ট লিঙ্ক\n` +
        `🔹 !due — বকেয়া ফি\n` +
        `🔹 !attendance — উপস্থিতি\n` +
        `🔹 !receipt — পেমেন্ট রসিদ\n` +
        `🔹 !unlink — অ্যাকাউন্ট আনলিঙ্ক\n` +
        `🔹 !admin — অ্যাডমিনকে মেসেজ\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🤖 AI চ্যাট: যেকোনো প্রশ্ন বাংলায় লিখুন (! ছাড়া)\n\n` +
        `📞 সাহায্যের জন্য: 01724-084350`
    );
}

async function handleNotice(msg) {
    const notices = await getDb('sabuj/notices');
    let text = `📢 *নোটিশ বোর্ড*\n\n━━━━━━━━━━━━━━━━━━\n`;

    if (notices && typeof notices === 'object') {
        const sorted = Object.entries(notices)
            .sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''))
            .slice(0, 5);

        for (const [, n] of sorted) {
            text += `📌 *${n.title || 'নোটিশ'}*\n🗓️ _${n.date || ''}_\n${n.details || ''}\n\n`;
        }
    } else {
        text += `বর্তমানে কোনো নোটিশ নেই।\n`;
    }
    await msg.reply(text);
}

async function handleLinkAccount(msg, chatId, text, state) {
    const apps = (await getDb('sabuj/applications')) || {};
    let foundKey = null;

    for (const [key, details] of Object.entries(apps)) {
        const reg   = String(details.regNo || '');
        const phone = String(details.personal?.phone || '');
        if (text === reg || text === phone) {
            foundKey = key;
            break;
        }
    }

    if (foundKey) {
        await patchDb(`sabuj/telegram_users/${chatId}`, {
            appId:        foundKey,
            linkedAt:     new Date().toISOString(),
            platform:     'whatsapp',
            whatsappName: (await msg.getContact()).pushname || '',
        });
        state.awaiting = '';
        await msg.reply(
            `✅ *অ্যাকাউন্ট সফলভাবে লিঙ্ক হয়েছে!* 🎉\n\n` +
            `এখন আপনি নিচের কমান্ডগুলো ব্যবহার করতে পারবেন:\n\n` +
            `🔹 !due — বকেয়া ফি জানতে\n` +
            `🔹 !attendance — উপস্থিতির স্ট্যাটাস\n` +
            `🔹 !receipt — পেমেন্ট রসিদ\n` +
            `🔹 !unlink — অ্যাকাউন্ট আনলিঙ্ক`
        );
    } else {
        await msg.reply(
            `❌ তথ্য পাওয়া যায়নি।\n\n` +
            `সঠিক *ফোন নম্বর* বা *রেজিস্ট্রেশন নম্বর* দিয়ে আবার চেষ্টা করুন।\n` +
            `সমস্যা হলে সরাসরি যোগাযোগ করুন: 📞 01724-084350`
        );
    }
}

async function handleTalkAdmin(msg, chatId, text, state) {
    state.awaiting = '';
    if (!ADMIN_PHONE) {
        await msg.reply('⚠️ অ্যাডমিন কনফিগার করা নেই। সরাসরি যোগাযোগ করুন: 📞 01724-084350');
        return;
    }
    const contact = await msg.getContact();
    try {
        await client.sendMessage(
            ADMIN_PHONE,
            `📨 *নতুন সাপোর্ট মেসেজ (WhatsApp)*\n\n` +
            `👤 নাম: ${contact.pushname || 'অজানা'}\n` +
            `📱 নম্বর: ${chatId.replace('@c.us', '')}\n` +
            `[CHATID:${chatId}]\n\n` +
            `💬 মেসেজ:\n${text}`
        );
        await msg.reply(
            `✅ আপনার মেসেজ অ্যাডমিনের কাছে পাঠানো হয়েছে।\n` +
            `রিপ্লাই পেলে এখানেই নোটিফিকেশন আসবে। ⏳`
        );
    } catch (e) {
        await msg.reply('❌ মেসেজ পাঠাতে সমস্যা হয়েছে। সরাসরি যোগাযোগ করুন: 📞 01724-084350');
    }
}

async function handleDue(msg, chatId) {
    const linked = await getDb(`sabuj/telegram_users/${chatId}`);
    if (!linked?.appId) {
        await msg.reply(`❌ অ্যাকাউন্ট লিঙ্ক করা নেই।\n*!link* টাইপ করে অ্যাকাউন্ট লিঙ্ক করুন।`);
        return;
    }

    const appData = await getDb(`sabuj/applications/${linked.appId}`);
    if (!appData) { await msg.reply('❌ ডাটাবেস থেকে তথ্য পাওয়া যায়নি।'); return; }

    const { total = 0, paid = 0, due = 0 } = appData.payment || {};
    const name = appData.personal?.nameBn || 'শিক্ষার্থী';
    const icon = parseInt(due) === 0 ? '✅' : '⚠️';

    let text = (
        `💳 *ফি স্ট্যাটাস — ${name}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 মোট ফি:     ৳${total}\n` +
        `✅ পরিশোধিত: ৳${paid}\n` +
        `${icon} বকেয়া ফি:  ৳${due}\n` +
        `━━━━━━━━━━━━━━━━━━`
    );
    await msg.reply(text);

    if (parseInt(due) > 0) {
        await msg.reply(
            `🔔 *রিমাইন্ডার:* দয়া করে বকেয়া ফি দ্রুত পরিশোধ করুন।\n` +
            `📞 যোগাযোগ: 01724-084350`
        );
    }
}

async function handleAttendance(msg, chatId) {
    const linked = await getDb(`sabuj/telegram_users/${chatId}`);
    if (!linked?.appId) {
        await msg.reply(`❌ অ্যাকাউন্ট লিঙ্ক করা নেই। *!link* দিয়ে লিঙ্ক করুন।`);
        return;
    }

    const stuData = await getDb(`sabuj/applications/${linked.appId}`);
    if (!stuData) { await msg.reply('❌ ডাটাবেস থেকে তথ্য পাওয়া যায়নি।'); return; }

    const name       = stuData.personal?.nameBn || 'শিক্ষার্থী';
    const attendance = stuData.attendance;

    let text;
    if (attendance && typeof attendance === 'object') {
        const present = attendance.present || 0;
        const absent  = attendance.absent  || 0;
        const total   = present + absent;
        const pct     = total > 0 ? Math.round((present / total) * 100) : 0;
        text = (
            `📋 *অ্যাটেনডেন্স — ${name}*\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ উপস্থিত:    ${present} দিন\n` +
            `❌ অনুপস্থিত: ${absent} দিন\n` +
            `📊 হাজিরা:     ${pct}%\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🌐 পোর্টাল: https://sabujcomputers.pro.bd/portal.html`
        );
    } else {
        text = (
            `📋 *অ্যাটেনডেন্স — ${name}*\n\n` +
            `উপস্থিতির তথ্য নিয়মিত আপডেট হচ্ছে।\n` +
            `বিস্তারিত: https://sabujcomputers.pro.bd/portal.html`
        );
    }
    await msg.reply(text);
}

async function handleReceipt(msg, chatId) {
    const linked = await getDb(`sabuj/telegram_users/${chatId}`);
    if (!linked?.appId) {
        await msg.reply(`❌ অ্যাকাউন্ট লিঙ্ক করা নেই। *!link* দিয়ে লিঙ্ক করুন।`);
        return;
    }

    const appData = await getDb(`sabuj/applications/${linked.appId}`);
    if (!appData) { await msg.reply('❌ ডাটাবেস থেকে তথ্য পাওয়া যায়নি।'); return; }

    const { total = 0, paid = 0, due = 0 } = appData.payment || {};
    const name = appData.personal?.nameEn || 'Student';
    const reg  = appData.regNo || 'N/A';

    const receipt = (
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🧾 *DIGITAL RECEIPT*\n` +
        `   সবুজ কম্পিউটার ট্রেনিং সেন্টার\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📅 তারিখ:          ${nowStr()}\n` +
        `👤 নাম:            ${name}\n` +
        `🆔 রেজিস্ট্রেশন: ${reg}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 মোট ফি:       ৳${total}\n` +
        `✅ পরিশোধিত:   ৳${paid}\n` +
        `⚠️ বকেয়া:        ৳${due}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ System Generated | Official Receipt`
    );
    await msg.reply(receipt);
}

async function handleUnlink(msg, chatId) {
    const linked = await getDb(`sabuj/telegram_users/${chatId}`);
    if (linked) {
        await deleteDb(`sabuj/telegram_users/${chatId}`);
        await msg.reply(
            `✅ আপনার অ্যাকাউন্ট সফলভাবে আনলিঙ্ক করা হয়েছে।\n` +
            `পুনরায় লিঙ্ক করতে *!link* টাইপ করুন।`
        );
    } else {
        await msg.reply('⚠️ আপনার অ্যাকাউন্ট আগে থেকেই লিঙ্ক করা নেই।');
    }
}

// ── Admin Commands ──

async function handleBroadcast(msg, chatId, text) {
    if (!isAdmin(chatId)) {
        await msg.reply('❌ এই কমান্ডটি শুধু অ্যাডমিন ব্যবহার করতে পারবেন।');
        return;
    }
    const parts = text.split(' ').slice(1).join(' ');
    if (!parts) { await msg.reply('সঠিক নিয়ম: `!broadcast আপনার মেসেজ`'); return; }

    const users = await getDb('sabuj/telegram_users');
    if (!users) { await msg.reply('কোনো লিঙ্কড ইউজার পাওয়া যায়নি।'); return; }

    let success = 0, failed = 0;
    for (const uid of Object.keys(users)) {
        try {
            await client.sendMessage(uid, `📢 *সেন্টার থেকে বিজ্ঞপ্তি:*\n\n${parts}`);
            success++;
        } catch { failed++; }
    }
    await msg.reply(`📊 *ব্রডকাস্ট রিপোর্ট:*\n\n✅ সফল: ${success} জন\n❌ ব্যর্থ: ${failed} জন`);
}

async function handleAddNotice(msg, chatId, text) {
    if (!isAdmin(chatId)) { await msg.reply('❌ অ্যাডমিন পারমিশন নেই।'); return; }

    const parts = text.split(' ').slice(1).join(' ');
    if (!parts) {
        await msg.reply('সঠিক নিয়ম:\n`!add_notice টাইটেল | বিবরণ`\n\nঅথবা:\n`!add_notice বিবরণ`');
        return;
    }

    const segments = parts.split('|');
    const title    = segments.length > 1 ? segments[0].trim() : 'নতুন নোটিশ';
    const details  = segments.length > 1 ? segments[1].trim() : segments[0].trim();
    const dateStr  = nowStr();

    await putDb(`sabuj/notices/t${nowTs()}`, { title, details, date: dateStr });

    // Notify all linked users
    const users = await getDb('sabuj/telegram_users');
    let success = 0, failed = 0;
    if (users) {
        for (const uid of Object.keys(users)) {
            try {
                await client.sendMessage(uid, `📌 *নতুন নোটিশ: ${title}*\n\n${details}\n\n🗓️ _${dateStr}_`);
                success++;
            } catch { failed++; }
        }
    }
    await msg.reply(
        `✅ নোটিশ সংরক্ষিত এবং ${success} জনকে পাঠানো হয়েছে।` +
        (failed ? ` (${failed} জনের কাছে পৌঁছানো যায়নি।)` : '')
    );
}

async function handleDeleteNotice(msg, chatId, text) {
    if (!isAdmin(chatId)) { await msg.reply('❌ অ্যাডমিন পারমিশন নেই।'); return; }

    const parts = text.split(' ');
    if (parts.length < 2) {
        const notices = await getDb('sabuj/notices');
        if (!notices) { await msg.reply('কোনো নোটিশ নেই।'); return; }
        let list = `📋 *নোটিশ তালিকা (key সহ):*\n\n`;
        for (const [key, n] of Object.entries(notices).slice(0, 10)) {
            list += `🔑 \`${key}\` — ${n.title || ''}\n`;
        }
        list += `\n\`!delete_notice <key>\` দিয়ে মুছুন`;
        await msg.reply(list);
        return;
    }

    const key = parts[1];
    const ok  = await deleteDb(`sabuj/notices/${key}`);
    await msg.reply(ok
        ? `✅ নোটিশ \`${key}\` মুছে ফেলা হয়েছে।`
        : `❌ মুছতে সমস্যা হয়েছে। key টি সঠিক কিনা দেখুন।`
    );
}

async function handleVerifyStudent(msg, chatId, text) {
    if (!isAdmin(chatId)) { await msg.reply('❌ অ্যাডমিন পারমিশন নেই।'); return; }

    const parts = text.split(' ');
    if (parts.length < 2) {
        await msg.reply('সঠিক নিয়ম: `!verify_student <RegNo বা Phone>`');
        return;
    }

    const search = parts[1];
    const apps   = (await getDb('sabuj/applications')) || {};

    for (const [, data] of Object.entries(apps)) {
        const reg   = String(data.regNo || '');
        const phone = String(data.personal?.phone || '');
        if (search === reg || search === phone) {
            const name    = data.personal?.nameBn  || 'N/A';
            const nameEn  = data.personal?.nameEn  || 'N/A';
            const course  = data.enrollment?.courseId || 'N/A';
            const feeDue  = data.payment?.due  || 'N/A';
            const feePaid = data.payment?.paid || 'N/A';

            await msg.reply(
                `✅ *স্টুডেন্ট তথ্য পাওয়া গেছে*\n\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `👤 নাম (বাংলা): ${name}\n` +
                `👤 নাম (English): ${nameEn}\n` +
                `🆔 রেজিস্ট্রেশন: ${reg}\n` +
                `📞 ফোন: ${phone}\n` +
                `🎓 কোর্স: ${course}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `✅ পরিশোধিত: ৳${feePaid}\n` +
                `⚠️ বকেয়া: ৳${feeDue}`
            );
            return;
        }
    }
    await msg.reply('❌ কোনো স্টুডেন্ট ডাটা পাওয়া যায়নি।');
}

async function handleStats(msg, chatId) {
    if (!isAdmin(chatId)) { await msg.reply('❌ অ্যাডমিন পারমিশন নেই।'); return; }

    const apps    = (await getDb('sabuj/applications')) || {};
    const users   = (await getDb('sabuj/telegram_users')) || {};
    const notices = (await getDb('sabuj/notices')) || {};

    const totalApps    = Object.keys(apps).length;
    const linkedUsers  = Object.keys(users).length;
    const totalNotices = Object.keys(notices).length;

    let totalDue = 0, totalPaid = 0;
    for (const a of Object.values(apps)) {
        if (a.payment) {
            totalDue  += Number(a.payment.due  || 0);
            totalPaid += Number(a.payment.paid || 0);
        }
    }

    await msg.reply(
        `📊 *বট পরিসংখ্যান*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👨‍🎓 মোট শিক্ষার্থী:  ${totalApps}\n` +
        `🔗 লিঙ্কড ইউজার:  ${linkedUsers}\n` +
        `📢 মোট নোটিশ:    ${totalNotices}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `✅ মোট পরিশোধিত: ৳${totalPaid}\n` +
        `⚠️ মোট বকেয়া:    ৳${totalDue}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕐 আপডেট: ${nowStr()}`
    );
}

async function handleAI(msg, chatId, text, state) {
    try {
        const botSettings  = (await getDb('sabuj/bot_settings')) || {};
        const systemPrompt = botSettings.system_prompt || DEFAULT_SYSTEM_PROMPT;

        // Build conversation history (multi-turn)
        const history = state.chatHistory || [];
        history.push({ role: 'user', parts: [{ text }] });

        const chat = aiClient.chats.create({
            model: 'gemini-2.5-flash',
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.35,
                maxOutputTokens: 512,
            },
            history: history.slice(0, -1), // all except current message
        });

        const response = await chat.sendMessage({ message: text });
        const reply    = response.text?.trim() || 'দুঃখিত, কোনো উত্তর পাওয়া যায়নি।';

        // Save history
        history.push({ role: 'model', parts: [{ text: reply }] });
        if (history.length > MAX_HISTORY_TURNS * 2) {
            state.chatHistory = history.slice(-(MAX_HISTORY_TURNS * 2));
        } else {
            state.chatHistory = history;
        }

        await msg.reply(reply);
    } catch (e) {
        console.error('Gemini error:', e.message);
        await msg.reply(
            '⚠️ দুঃখিত, AI সার্ভারে সমস্যা হচ্ছে। মেনু দেখতে *!menu* টাইপ করুন।'
        );
    }
}

// ──────────────────────────────────────────────
// 🚀 Start Bot
// ──────────────────────────────────────────────
client.initialize();
