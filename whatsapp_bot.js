/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   সবুজ কম্পিউটার্স — WhatsApp Bot (Twilio Edition) ║
 * ║   whatsapp-web.js থেকে Twilio API-তে রূপান্তরিত    ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Features:
 *  - Twilio WhatsApp API (webhook-based, no Chrome/Puppeteer)
 *  - Gemini AI chat (multi-turn history)
 *  - Firebase Realtime DB (due/attendance/receipt/account linking)
 *  - Admin commands: broadcast, add_notice, delete_notice, verify_student, stats
 *  - Rate limiting
 *  - Admin reply forwarding
 *
 * Setup:
 *  1. npm install
 *  2. Set environment variables (see below)
 *  3. node whatsapp_bot.js
 *  4. Railway URL → Twilio Webhook এ সেট করুন:
 *     https://your-app.railway.app/webhook  (POST)
 */

const express    = require('express');
const twilio     = require('twilio');
const axios      = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ──────────────────────────────────────────────
// ⚙️ Environment & Constants
// ──────────────────────────────────────────────
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID   || '';
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN    || '';
const TWILIO_WA_NUMBER     = process.env.TWILIO_WA_NUMBER     || ''; // e.g. "whatsapp:+14155238886"
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY       || '';
const ADMIN_PHONE          = process.env.ADMIN_PHONE          || ''; // e.g. "whatsapp:+8801724084350"
const FIREBASE_URL         = process.env.FIREBASE_URL         || 'https://sabuj-computers-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_SECRET      = process.env.FIREBASE_SECRET      || '';
const PORT                 = process.env.PORT                 || 3000;

// Rate limiting config
const RATE_LIMIT_CALLS  = 5;   // max messages
const RATE_LIMIT_PERIOD = 30;  // per N seconds

const MAX_HISTORY_TURNS = 6;

// ──────────────────────────────────────────────
// 📤 Twilio Client
// ──────────────────────────────────────────────
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio client initialized.');
} else {
    console.warn('⚠️ Twilio credentials missing! Set TWILIO_ACCOUNT_SID & TWILIO_AUTH_TOKEN.');
}

// Twilio দিয়ে message পাঠানোর helper
async function sendMessage(to, body) {
    if (!twilioClient) {
        console.error('Twilio client not initialized.');
        return;
    }
    try {
        await twilioClient.messages.create({
            from: TWILIO_WA_NUMBER,
            to:   to,
            body: body,
        });
    } catch (e) {
        console.error(`Twilio send error [${to}]:`, e.message);
    }
}

// ──────────────────────────────────────────────
// 🤖 Gemini AI Setup
// ──────────────────────────────────────────────
let aiClient = null;
if (GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log('✅ Gemini AI client initialized.');
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant for 'Sabuj Computers Training Center' (সবুজ কম্পিউটার ট্রেনিং সেন্টার), located at Tamaltala Bazar, Bagatipara, Natore, Bangladesh. Always respond in polite, friendly Bengali. Always greet with 'আসসালামু আলাইকুম' — never use 'নমস্কার'. Office hours: Sat–Thu 9:00 AM–1:30 PM & 4:00 PM–8:30 PM (Friday closed). Courses: (1) Foundation Course — 6 months, ৳3500. (2) BTEB Course — 6 months, ৳4500 (Govt approved). Phone: 01724-084350. Email: sssabuj007@gmail.com. Website: https://sabujcomputers.pro.bd. Keep answers concise and helpful. If the user asks about their fee, attendance, or receipt, tell them to use !due, !attendance, or !receipt after linking their account via !link. Do not make up information. If you don't know something, say so politely.`;

// ──────────────────────────────────────────────
// 🗄️ Firebase Helpers
// ──────────────────────────────────────────────
function authParam() {
    return FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
}

async function getDb(path) {
    try {
        const res = await axios.get(`${FIREBASE_URL}/${path}.json${authParam()}`, { timeout: 8000 });
        return res.data;
    } catch (e) {
        console.error(`GET error [${path}]:`, e.message);
        return null;
    }
}

async function putDb(path, data) {
    try {
        const res = await axios.put(`${FIREBASE_URL}/${path}.json${authParam()}`, data, { timeout: 8000 });
        return res.data;
    } catch (e) {
        console.error(`PUT error [${path}]:`, e.message);
        return null;
    }
}

async function patchDb(path, data) {
    try {
        const res = await axios.patch(`${FIREBASE_URL}/${path}.json${authParam()}`, data, { timeout: 8000 });
        return res.data;
    } catch (e) {
        console.error(`PATCH error [${path}]:`, e.message);
        return null;
    }
}

async function deleteDb(path) {
    try {
        const res = await axios.delete(`${FIREBASE_URL}/${path}.json${authParam()}`, { timeout: 8000 });
        return res.status === 200;
    } catch (e) {
        console.error(`DELETE error [${path}]:`, e.message);
        return false;
    }
}

function nowStr() {
    return new Date().toLocaleString('en-BD', {
        timeZone:  'Asia/Dhaka',
        year:      'numeric', month:  '2-digit', day:    '2-digit',
        hour:      '2-digit', minute: '2-digit', hour12: true,
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
    // chatId format: "whatsapp:+8801724084350"
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
// 💬 User State Storage (in-memory)
// ──────────────────────────────────────────────
const userState = new Map(); // chatId -> { awaiting, chatHistory }

function getState(chatId) {
    if (!userState.has(chatId)) userState.set(chatId, { awaiting: '', chatHistory: [] });
    return userState.get(chatId);
}

// ──────────────────────────────────────────────
// 📋 Menu Texts
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

// ──────────────────────────────────────────────
// 📦 Feature Handlers
// ──────────────────────────────────────────────

async function handleCourses(chatId) {
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
    await sendMessage(chatId, text);
}

async function handleNotice(chatId) {
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
    await sendMessage(chatId, text);
}

async function handleLinkAccount(chatId, text, state) {
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
        // chatId format: "whatsapp:+8801XXXXXXXXX"
        await patchDb(`sabuj/telegram_users/${encodeKey(chatId)}`, {
            appId:    foundKey,
            linkedAt: new Date().toISOString(),
            platform: 'whatsapp_twilio',
            phone:    chatId,
        });
        state.awaiting = '';
        await sendMessage(chatId,
            `✅ *অ্যাকাউন্ট সফলভাবে লিঙ্ক হয়েছে!* 🎉\n\n` +
            `এখন আপনি নিচের কমান্ডগুলো ব্যবহার করতে পারবেন:\n\n` +
            `🔹 !due — বকেয়া ফি জানতে\n` +
            `🔹 !attendance — উপস্থিতির স্ট্যাটাস\n` +
            `🔹 !receipt — পেমেন্ট রসিদ\n` +
            `🔹 !unlink — অ্যাকাউন্ট আনলিঙ্ক`
        );
    } else {
        await sendMessage(chatId,
            `❌ তথ্য পাওয়া যায়নি।\n\n` +
            `সঠিক *ফোন নম্বর* বা *রেজিস্ট্রেশন নম্বর* দিয়ে আবার চেষ্টা করুন।\n` +
            `সমস্যা হলে সরাসরি যোগাযোগ করুন: 📞 01724-084350`
        );
    }
}

async function handleTalkAdmin(chatId, text, senderName, state) {
    state.awaiting = '';
    if (!ADMIN_PHONE) {
        await sendMessage(chatId, '⚠️ অ্যাডমিন কনফিগার করা নেই। সরাসরি যোগাযোগ করুন: 📞 01724-084350');
        return;
    }
    const phone = chatId.replace('whatsapp:', '');
    try {
        await sendMessage(ADMIN_PHONE,
            `📨 *নতুন সাপোর্ট মেসেজ (WhatsApp)*\n\n` +
            `👤 নাম: ${senderName || 'অজানা'}\n` +
            `📱 নম্বর: ${phone}\n` +
            `[REPLYTO:${chatId}]\n\n` +
            `💬 মেসেজ:\n${text}`
        );
        await sendMessage(chatId,
            `✅ আপনার মেসেজ অ্যাডমিনের কাছে পাঠানো হয়েছে।\n` +
            `রিপ্লাই পেলে এখানেই নোটিফিকেশন আসবে। ⏳`
        );
    } catch (e) {
        await sendMessage(chatId, '❌ মেসেজ পাঠাতে সমস্যা হয়েছে। সরাসরি যোগাযোগ করুন: 📞 01724-084350');
    }
}

async function handleDue(chatId) {
    const key    = encodeKey(chatId);
    const linked = await getDb(`sabuj/telegram_users/${key}`);
    if (!linked?.appId) {
        await sendMessage(chatId, `❌ অ্যাকাউন্ট লিঙ্ক করা নেই।\n*!link* টাইপ করে অ্যাকাউন্ট লিঙ্ক করুন।`);
        return;
    }

    const appData = await getDb(`sabuj/applications/${linked.appId}`);
    if (!appData) { await sendMessage(chatId, '❌ ডাটাবেস থেকে তথ্য পাওয়া যায়নি।'); return; }

    const { total = 0, paid = 0, due = 0 } = appData.payment || {};
    const name = appData.personal?.nameBn || 'শিক্ষার্থী';
    const icon = parseInt(due) === 0 ? '✅' : '⚠️';

    await sendMessage(chatId,
        `💳 *ফি স্ট্যাটাস — ${name}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 মোট ফি:     ৳${total}\n` +
        `✅ পরিশোধিত: ৳${paid}\n` +
        `${icon} বকেয়া ফি:  ৳${due}\n` +
        `━━━━━━━━━━━━━━━━━━`
    );

    if (parseInt(due) > 0) {
        await sendMessage(chatId,
            `🔔 *রিমাইন্ডার:* দয়া করে বকেয়া ফি দ্রুত পরিশোধ করুন।\n` +
            `📞 যোগাযোগ: 01724-084350`
        );
    }
}

async function handleAttendance(chatId) {
    const key    = encodeKey(chatId);
    const linked = await getDb(`sabuj/telegram_users/${key}`);
    if (!linked?.appId) {
        await sendMessage(chatId, `❌ অ্যাকাউন্ট লিঙ্ক করা নেই। *!link* দিয়ে লিঙ্ক করুন।`);
        return;
    }

    const stuData = await getDb(`sabuj/applications/${linked.appId}`);
    if (!stuData) { await sendMessage(chatId, '❌ ডাটাবেস থেকে তথ্য পাওয়া যায়নি।'); return; }

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
    await sendMessage(chatId, text);
}

async function handleReceipt(chatId) {
    const key    = encodeKey(chatId);
    const linked = await getDb(`sabuj/telegram_users/${key}`);
    if (!linked?.appId) {
        await sendMessage(chatId, `❌ অ্যাকাউন্ট লিঙ্ক করা নেই। *!link* দিয়ে লিঙ্ক করুন।`);
        return;
    }

    const appData = await getDb(`sabuj/applications/${linked.appId}`);
    if (!appData) { await sendMessage(chatId, '❌ ডাটাবেস থেকে তথ্য পাওয়া যায়নি।'); return; }

    const { total = 0, paid = 0, due = 0 } = appData.payment || {};
    const name = appData.personal?.nameEn || 'Student';
    const reg  = appData.regNo || 'N/A';

    await sendMessage(chatId,
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
}

async function handleUnlink(chatId) {
    const key    = encodeKey(chatId);
    const linked = await getDb(`sabuj/telegram_users/${key}`);
    if (linked) {
        await deleteDb(`sabuj/telegram_users/${key}`);
        await sendMessage(chatId,
            `✅ আপনার অ্যাকাউন্ট সফলভাবে আনলিঙ্ক করা হয়েছে।\n` +
            `পুনরায় লিঙ্ক করতে *!link* টাইপ করুন।`
        );
    } else {
        await sendMessage(chatId, '⚠️ আপনার অ্যাকাউন্ট আগে থেকেই লিঙ্ক করা নেই।');
    }
}

// ── Admin Commands ──

async function handleBroadcast(chatId, text) {
    if (!isAdmin(chatId)) {
        await sendMessage(chatId, '❌ এই কমান্ডটি শুধু অ্যাডমিন ব্যবহার করতে পারবেন।');
        return;
    }
    const parts = text.split(' ').slice(1).join(' ');
    if (!parts) { await sendMessage(chatId, 'সঠিক নিয়ম: `!broadcast আপনার মেসেজ`'); return; }

    const users = await getDb('sabuj/telegram_users');
    if (!users) { await sendMessage(chatId, 'কোনো লিঙ্কড ইউজার পাওয়া যায়নি।'); return; }

    let success = 0, failed = 0;
    for (const [, userData] of Object.entries(users)) {
        const targetPhone = userData.phone;
        if (!targetPhone) { failed++; continue; }
        try {
            await sendMessage(targetPhone, `📢 *সেন্টার থেকে বিজ্ঞপ্তি:*\n\n${parts}`);
            success++;
        } catch { failed++; }
    }
    await sendMessage(chatId, `📊 *ব্রডকাস্ট রিপোর্ট:*\n\n✅ সফল: ${success} জন\n❌ ব্যর্থ: ${failed} জন`);
}

async function handleAddNotice(chatId, text) {
    if (!isAdmin(chatId)) { await sendMessage(chatId, '❌ অ্যাডমিন পারমিশন নেই।'); return; }

    const parts = text.split(' ').slice(1).join(' ');
    if (!parts) {
        await sendMessage(chatId,
            'সঠিক নিয়ম:\n`!add_notice টাইটেল | বিবরণ`\n\nঅথবা:\n`!add_notice বিবরণ`'
        );
        return;
    }

    const segments = parts.split('|');
    const title    = segments.length > 1 ? segments[0].trim() : 'নতুন নোটিশ';
    const details  = segments.length > 1 ? segments[1].trim() : segments[0].trim();
    const dateStr  = nowStr();

    await putDb(`sabuj/notices/t${nowTs()}`, { title, details, date: dateStr });

    // সব linked user-কে notify করুন
    const users = await getDb('sabuj/telegram_users');
    let success = 0, failed = 0;
    if (users) {
        for (const [, userData] of Object.entries(users)) {
            const targetPhone = userData.phone;
            if (!targetPhone) { failed++; continue; }
            try {
                await sendMessage(targetPhone, `📌 *নতুন নোটিশ: ${title}*\n\n${details}\n\n🗓️ _${dateStr}_`);
                success++;
            } catch { failed++; }
        }
    }
    await sendMessage(chatId,
        `✅ নোটিশ সংরক্ষিত এবং ${success} জনকে পাঠানো হয়েছে।` +
        (failed ? ` (${failed} জনের কাছে পৌঁছানো যায়নি।)` : '')
    );
}

async function handleDeleteNotice(chatId, text) {
    if (!isAdmin(chatId)) { await sendMessage(chatId, '❌ অ্যাডমিন পারমিশন নেই।'); return; }

    const parts = text.split(' ');
    if (parts.length < 2) {
        const notices = await getDb('sabuj/notices');
        if (!notices) { await sendMessage(chatId, 'কোনো নোটিশ নেই।'); return; }
        let list = `📋 *নোটিশ তালিকা (key সহ):*\n\n`;
        for (const [key, n] of Object.entries(notices).slice(0, 10)) {
            list += `🔑 \`${key}\` — ${n.title || ''}\n`;
        }
        list += `\n\`!delete_notice <key>\` দিয়ে মুছুন`;
        await sendMessage(chatId, list);
        return;
    }

    const key = parts[1];
    const ok  = await deleteDb(`sabuj/notices/${key}`);
    await sendMessage(chatId, ok
        ? `✅ নোটিশ \`${key}\` মুছে ফেলা হয়েছে।`
        : `❌ মুছতে সমস্যা হয়েছে। key টি সঠিক কিনা দেখুন।`
    );
}

async function handleVerifyStudent(chatId, text) {
    if (!isAdmin(chatId)) { await sendMessage(chatId, '❌ অ্যাডমিন পারমিশন নেই।'); return; }

    const parts = text.split(' ');
    if (parts.length < 2) {
        await sendMessage(chatId, 'সঠিক নিয়ম: `!verify_student <RegNo বা Phone>`');
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

            await sendMessage(chatId,
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
    await sendMessage(chatId, '❌ কোনো স্টুডেন্ট ডাটা পাওয়া যায়নি।');
}

async function handleStats(chatId) {
    if (!isAdmin(chatId)) { await sendMessage(chatId, '❌ অ্যাডমিন পারমিশন নেই।'); return; }

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

    await sendMessage(chatId,
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

async function handleAI(chatId, text, state) {
    try {
        const botSettings  = (await getDb('sabuj/bot_settings')) || {};
        const systemPrompt = botSettings.system_prompt || DEFAULT_SYSTEM_PROMPT;

        const history = state.chatHistory || [];
        history.push({ role: 'user', parts: [{ text }] });

        const chat = aiClient.chats.create({
            model: 'gemini-2.5-flash',
            config: {
                systemInstruction: systemPrompt,
                temperature:       0.35,
                maxOutputTokens:   512,
            },
            history: history.slice(0, -1),
        });

        const response = await chat.sendMessage({ message: text });
        const reply    = response.text?.trim() || 'দুঃখিত, কোনো উত্তর পাওয়া যায়নি।';

        history.push({ role: 'model', parts: [{ text: reply }] });
        state.chatHistory = history.length > MAX_HISTORY_TURNS * 2
            ? history.slice(-(MAX_HISTORY_TURNS * 2))
            : history;

        await sendMessage(chatId, reply);
    } catch (e) {
        console.error('Gemini error:', e.message);
        await sendMessage(chatId, '⚠️ দুঃখিত, AI সার্ভারে সমস্যা হচ্ছে। মেনু দেখতে *!menu* টাইপ করুন।');
    }
}

// ──────────────────────────────────────────────
// 🔑 Firebase key encoding
// (Firebase key-এ '+', ':', '@' ইত্যাদি চলে না)
// chatId: "whatsapp:+8801724084350"
// ──────────────────────────────────────────────
function encodeKey(chatId) {
    // "whatsapp:+8801724084350" → "wa_8801724084350"
    return 'wa_' + chatId.replace('whatsapp:+', '').replace(/\D/g, '');
}

// ──────────────────────────────────────────────
// 📨 Main Webhook Handler
// ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    // Twilio এর request এর সাথে সাথে 200 পাঠান (timeout এড়াতে)
    res.status(200).send('OK');

    const chatId     = req.body.From   || '';   // e.g. "whatsapp:+8801XXXXXXXXX"
    const text       = (req.body.Body  || '').trim();
    const senderName = req.body.ProfileName || '';

    if (!chatId || chatId === 'whatsapp:') return;

    const state = getState(chatId);

    // ── Rate limit (admin বাদে) ──
    if (!isAdmin(chatId) && isRateLimited(chatId)) {
        await sendMessage(chatId, '⏳ একটু থামুন! অনেক দ্রুত মেসেজ পাঠাচ্ছেন। কিছুক্ষণ পর আবার চেষ্টা করুন।');
        return;
    }

    // ── Admin: user-কে reply forward করুন ──
    // Admin লেখেন: "reply whatsapp:+880... আপনার রিপ্লাই মেসেজ"
    // অথবা আগের মেসেজে [REPLYTO:...] ছিল — এখানে সহজ command-based পদ্ধতি:
    if (isAdmin(chatId) && text.toLowerCase().startsWith('reply ')) {
        const parts  = text.split(' ');
        const target = parts[1]; // whatsapp:+880XXXXXXXXX
        const reply  = parts.slice(2).join(' ');
        if (target && reply) {
            await sendMessage(target, `🎧 *অ্যাডমিনের রিপ্লাই:*\n\n${reply}`);
            await sendMessage(chatId, `✅ রিপ্লাই পাঠানো হয়েছে → ${target}`);
        } else {
            await sendMessage(chatId, 'সঠিক নিয়ম: `reply whatsapp:+880XXXXXXXXX আপনার রিপ্লাই`');
        }
        return;
    }

    // ── State: Account Linking ──
    if (state.awaiting === 'link_reg') {
        await handleLinkAccount(chatId, text, state);
        return;
    }

    // ── State: Talk to Admin ──
    if (state.awaiting === 'talk_admin') {
        await handleTalkAdmin(chatId, text, senderName, state);
        return;
    }

    // ── Commands ──
    const cmd = text.toLowerCase().split(' ')[0];

    switch (cmd) {
        case '!start':
        case '!menu':
            await sendMessage(chatId, mainMenuText());
            break;

        case '!help':
            await sendMessage(chatId, helpText());
            break;

        case '!courses':
            await handleCourses(chatId);
            break;

        case '!fees':
            await sendMessage(chatId, feesText());
            break;

        case '!admission':
            await sendMessage(chatId, admissionText());
            break;

        case '!results':
            await sendMessage(chatId,
                `🏆 *ফলাফল ও সার্টিফিকেট যাচাই*\n\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `আপনার রেজিস্ট্রেশন নম্বর দিয়ে অনলাইনে যাচাই করুন:\n\n` +
                `🔗 https://sabujcomputers.pro.bd/verify.html`
            );
            break;

        case '!notice':
            await handleNotice(chatId);
            break;

        case '!contact':
            await sendMessage(chatId, contactText());
            break;

        case '!link':
            state.awaiting = 'link_reg';
            await sendMessage(chatId,
                `🔗 *অ্যাকাউন্ট লিঙ্ক করুন*\n\n` +
                `আপনার *ফোন নম্বর* অথবা *রেজিস্ট্রেশন নম্বর* টাইপ করে সেন্ড করুন:\n\n` +
                `_(উদাহরণ: 01724084350 বা SC-2024-001)_`
            );
            break;

        case '!due':
            await handleDue(chatId);
            break;

        case '!attendance':
            await handleAttendance(chatId);
            break;

        case '!receipt':
            await handleReceipt(chatId);
            break;

        case '!unlink':
            await handleUnlink(chatId);
            break;

        case '!admin':
            state.awaiting = 'talk_admin';
            await sendMessage(chatId,
                `🎧 *সরাসরি অ্যাডমিনের সাথে কথা বলুন*\n\n` +
                `আপনার প্রশ্ন বা মেসেজটি এখন টাইপ করে সেন্ড করুন।\n` +
                `অ্যাডমিন কিছুক্ষণের মধ্যে রিপ্লাই দেবেন। ⏳`
            );
            break;

        // ── Admin Commands ──
        case '!broadcast':
            await handleBroadcast(chatId, text);
            break;

        case '!add_notice':
            await handleAddNotice(chatId, text);
            break;

        case '!delete_notice':
            await handleDeleteNotice(chatId, text);
            break;

        case '!verify_student':
            await handleVerifyStudent(chatId, text);
            break;

        case '!stats':
            await handleStats(chatId);
            break;

        default:
            // ── Gemini AI (free text) ──
            if (!text.startsWith('!') && aiClient) {
                await handleAI(chatId, text, state);
            } else if (text.startsWith('!')) {
                await sendMessage(chatId, `❓ কমান্ড বোঝা যায়নি। *!help* টাইপ করুন সব কমান্ড দেখতে।`);
            } else {
                await sendMessage(chatId, `আমি বুঝতে পারিনি। *!menu* টাইপ করুন মেনু দেখতে।`);
            }
    }
});

// Health check endpoint (Railway জন্য)
app.get('/', (req, res) => {
    res.send('✅ সবুজ কম্পিউটার্স WhatsApp Bot চলছে!');
});

// ──────────────────────────────────────────────
// 🚀 Server Start
// ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ সবুজ কম্পিউটার্স WhatsApp Bot চালু!`);
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📡 Webhook URL: https://your-app.railway.app/webhook`);
    console.log(`\n📋 Environment Check:`);
    console.log(`   Twilio SID:    ${TWILIO_ACCOUNT_SID ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Twilio Token:  ${TWILIO_AUTH_TOKEN  ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Twilio Number: ${TWILIO_WA_NUMBER   ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Gemini Key:    ${GEMINI_API_KEY     ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Admin Phone:   ${ADMIN_PHONE        ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Firebase URL:  ${FIREBASE_URL       ? '✅ Set' : '❌ Missing'}`);
});
