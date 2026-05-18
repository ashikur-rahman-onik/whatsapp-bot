/**
 * ╔══════════════════════════════════════════════════╗
 * ║  সবুজ কম্পিউটার্স — WhatsApp Bot                ║
 * ║  Meta Cloud API Edition (Unlimited & Free!)      ║
 * ╚══════════════════════════════════════════════════╝
 *
 * Environment Variables (Railway-তে দিন):
 *  WA_TOKEN         = System User Access Token
 *  WA_PHONE_ID      = Phone Number ID (e.g. 1114774468386227)
 *  WA_VERIFY_TOKEN  = যেকোনো secret (e.g. sabuj_verify_2024)
 *  ADMIN_PHONE      = 8801724084350  (+ ছাড়া)
 *  GEMINI_API_KEY   = Google Gemini key
 *  FIREBASE_URL     = Firebase DB URL
 *  FIREBASE_SECRET  = Firebase secret
 */

const express = require('express');
const axios   = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// ── Env ──
const WA_TOKEN        = process.env.WA_TOKEN        || '';
const WA_PHONE_ID     = process.env.WA_PHONE_ID     || '';
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'sabuj_verify_2024';
const ADMIN_PHONE     = process.env.ADMIN_PHONE     || '';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY  || '';
const FIREBASE_URL    = process.env.FIREBASE_URL    || 'https://sabuj-computers-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const PORT            = process.env.PORT            || 3000;

const RATE_LIMIT_CALLS  = 10;
const RATE_LIMIT_PERIOD = 30;
const MAX_HISTORY_TURNS = 6;

// ── Meta API: Message পাঠানো ──
async function sendMessage(to, body) {
    const phone = String(to).replace(/^\+/, '');
    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to:   phone,
                type: 'text',
                text: { body, preview_url: false },
            },
            {
                headers: {
                    Authorization:  `Bearer ${WA_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
    } catch (e) {
        const err = e.response?.data?.error?.message || e.message;
        console.error(`Meta send error [${phone}]:`, err);
    }
}

// ── Gemini AI ──
let aiClient = null;
if (GEMINI_API_KEY) {
    aiClient = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log('✅ Gemini AI initialized.');
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant for 'Sabuj Computers Training Center' (সবুজ কম্পিউটার ট্রেনিং সেন্টার), located at Tamaltala Bazar, Bagatipara, Natore, Bangladesh. Always respond in polite, friendly Bengali. Always greet with 'আসসালামু আলাইকুম'. Office hours: Sat–Thu 9AM–1:30PM & 4PM–8:30PM (Friday closed). Courses: (1) Foundation — 6 months, ৳3500. (2) BTEB — 6 months, ৳4500. Phone: 01724-084350. Website: https://sabujcomputers.pro.bd. Keep answers concise. For fee/attendance/receipt questions, tell them to use !link then !due/!attendance/!receipt.`;

// ── Firebase ──
const fbAuth = () => FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
async function getDb(path) {
    try { return (await axios.get(`${FIREBASE_URL}/${path}.json${fbAuth()}`, { timeout: 8000 })).data; }
    catch (e) { console.error(`GET [${path}]:`, e.message); return null; }
}
async function putDb(path, data) {
    try { return (await axios.put(`${FIREBASE_URL}/${path}.json${fbAuth()}`, data, { timeout: 8000 })).data; }
    catch (e) { console.error(`PUT [${path}]:`, e.message); return null; }
}
async function patchDb(path, data) {
    try { return (await axios.patch(`${FIREBASE_URL}/${path}.json${fbAuth()}`, data, { timeout: 8000 })).data; }
    catch (e) { console.error(`PATCH [${path}]:`, e.message); return null; }
}
async function deleteDb(path) {
    try { await axios.delete(`${FIREBASE_URL}/${path}.json${fbAuth()}`, { timeout: 8000 }); return true; }
    catch (e) { console.error(`DELETE [${path}]:`, e.message); return false; }
}

function nowStr() {
    return new Date().toLocaleString('en-BD', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
}
function nowTs() { return Math.floor(Date.now() / 1000); }
function encodeKey(phone) { return 'wa_' + String(phone).replace(/\D/g, ''); }

// ── Helpers ──
const rateLimitStore = new Map();
const userState      = new Map();

function isAdmin(phone) {
    return ADMIN_PHONE && String(phone).replace(/^\+/, '') === String(ADMIN_PHONE).replace(/^\+/, '');
}
function isRateLimited(phone) {
    const now = Date.now() / 1000;
    let calls = (rateLimitStore.get(phone) || []).filter(t => now - t < RATE_LIMIT_PERIOD);
    if (calls.length >= RATE_LIMIT_CALLS) return true;
    calls.push(now); rateLimitStore.set(phone, calls); return false;
}
function getState(phone) {
    if (!userState.has(phone)) userState.set(phone, { awaiting: '', chatHistory: [] });
    return userState.get(phone);
}

// ── Menu Texts ──
const mainMenuText = () =>
    `🌿 *সবুজ কম্পিউটার্সে আপনাকে স্বাগতম!*\n\nবাগাতিপাড়া, নাটোরের BTEB অনুমোদিত কম্পিউটার প্রশিক্ষণ কেন্দ্র।\nআমি একটি AI বট — স্বাভাবিক ভাষায় কথা বলুন!\n\n━━━━━━━━━━━━━━━━━━\n📌 *কমান্ডসমূহ:*\n\n1️⃣ !courses — কোর্স তালিকা\n2️⃣ !fees — ফি তথ্য\n3️⃣ !admission — ভর্তি\n4️⃣ !results — ফলাফল যাচাই\n5️⃣ !notice — নোটিশ বোর্ড\n6️⃣ !contact — যোগাযোগ\n7️⃣ !link — অ্যাকাউন্ট লিঙ্ক\n8️⃣ !due — বকেয়া ফি\n9️⃣ !attendance — উপস্থিতি\n🔟 !receipt — পেমেন্ট রসিদ\n🔁 !unlink — আনলিঙ্ক\n🎧 !admin — অ্যাডমিন\n❓ !help — সাহায্য\n\n━━━━━━━━━━━━━━━━━━\n🌐 https://sabujcomputers.pro.bd\n📞 01724-084350`;

const feesText = () =>
    `💰 *ফি তথ্য*\n\n━━━━━━━━━━━━━━━━━━\n🎓 *ফাউন্ডেশন কোর্স:* ৳৩,৫০০\n_(Basic Computer, MS Office, Internet — ৬ মাস)_\n\n🏆 *BTEB কোর্স:* ৳৪,৫০০\n_(সরকারি সনদ, চাকরির বাজারে গ্রহণযোগ্য — ৬ মাস)_\n\n━━━━━━━━━━━━━━━━━━\n📞 01724-084350`;

const admissionText = () =>
    `📝 *ভর্তি তথ্য*\n\n━━━━━━━━━━━━━━━━━━\n📍 তমালতলা বাজার, বাগাতিপাড়া, নাটোর\n\n📋 *প্রয়োজনীয়:*\n• NID / জন্ম নিবন্ধন\n• ১ কপি ছবি\n\n⏰ সকাল ৯:০০ — রাত ৮:৩০\n_(শুক্রবার বন্ধ)_\n\n━━━━━━━━━━━━━━━━━━\n📞 01724-084350\n📝 https://sabujcomputers.pro.bd/admission-form.html`;

const contactText = () =>
    `📞 *যোগাযোগ*\n\n━━━━━━━━━━━━━━━━━━\n📞 01724-084350\n✉️ sssabuj007@gmail.com\n📍 তমালতলা বাজার, বাগাতিপাড়া, নাটোর\n💬 https://wa.me/8801724084350`;

const helpText = () =>
    `📖 *কমান্ড তালিকা*\n\n━━━━━━━━━━━━━━━━━━\n!menu !courses !fees !admission !results !notice !contact !link !due !attendance !receipt !unlink !admin\n\n🤖 AI চ্যাট: ! ছাড়া যেকোনো প্রশ্ন করুন\n📞 01724-084350`;

// ── Feature Handlers ──
async function handleCourses(phone) {
    const courses = await getDb('sabuj/courses');
    let text = `🎓 *কোর্সসমূহ*\n\n━━━━━━━━━━━━━━━━━━\n`;
    if (courses && typeof courses === 'object') {
        let i = 1;
        for (const [, c] of Object.entries(courses))
            text += `${i++}️⃣ *${c.name}*\n   ✅ ${c.duration} | ৳${c.fee} | ${c.cert}\n\n`;
    } else {
        text += `1️⃣ *ফাউন্ডেশন কোর্স*\n   ✅ ৬ মাস | ৳৩,৫০০ | নিজস্ব সনদ\n\n2️⃣ *BTEB কোর্স*\n   ✅ ৬ মাস | ৳৪,৫০০ | সরকারি সনদ\n\n━━━━━━━━━━━━━━━━━━\n📞 01724-084350`;
    }
    await sendMessage(phone, text);
}

async function handleNotice(phone) {
    const notices = await getDb('sabuj/notices');
    let text = `📢 *নোটিশ বোর্ড*\n\n━━━━━━━━━━━━━━━━━━\n`;
    if (notices && typeof notices === 'object') {
        const sorted = Object.entries(notices).sort((a, b) => (b[1].date || '').localeCompare(a[1].date || '')).slice(0, 5);
        for (const [, n] of sorted)
            text += `📌 *${n.title || 'নোটিশ'}*\n🗓️ ${n.date || ''}\n${n.details || ''}\n\n`;
    } else { text += `বর্তমানে কোনো নোটিশ নেই।`; }
    await sendMessage(phone, text);
}

async function handleLinkAccount(phone, text, state) {
    const apps = (await getDb('sabuj/applications')) || {};
    let foundKey = null;
    for (const [key, d] of Object.entries(apps)) {
        if (text === String(d.regNo || '') || text === String(d.personal?.phone || '')) { foundKey = key; break; }
    }
    if (foundKey) {
        await patchDb(`sabuj/telegram_users/${encodeKey(phone)}`, { appId: foundKey, linkedAt: new Date().toISOString(), platform: 'whatsapp_meta', phone });
        state.awaiting = '';
        await sendMessage(phone, `✅ *অ্যাকাউন্ট লিঙ্ক হয়েছে!* 🎉\n\nএখন ব্যবহার করুন:\n🔹 !due\n🔹 !attendance\n🔹 !receipt`);
    } else {
        await sendMessage(phone, `❌ তথ্য পাওয়া যায়নি।\nসঠিক ফোন/রেজিস্ট্রেশন নম্বর দিন।\n📞 01724-084350`);
    }
}

async function handleDue(phone) {
    const linked = await getDb(`sabuj/telegram_users/${encodeKey(phone)}`);
    if (!linked?.appId) { await sendMessage(phone, `❌ লিঙ্ক নেই। *!link* দিয়ে লিঙ্ক করুন।`); return; }
    const app = await getDb(`sabuj/applications/${linked.appId}`);
    if (!app) { await sendMessage(phone, '❌ তথ্য পাওয়া যায়নি।'); return; }
    const { total = 0, paid = 0, due = 0 } = app.payment || {};
    await sendMessage(phone,
        `💳 *ফি স্ট্যাটাস — ${app.personal?.nameBn || 'শিক্ষার্থী'}*\n\n━━━━━━━━━━━━━━━━━━\n📊 মোট: ৳${total}\n✅ পরিশোধিত: ৳${paid}\n${parseInt(due) === 0 ? '✅' : '⚠️'} বকেয়া: ৳${due}\n━━━━━━━━━━━━━━━━━━`
    );
    if (parseInt(due) > 0) await sendMessage(phone, `🔔 বকেয়া ফি পরিশোধ করুন।\n📞 01724-084350`);
}

async function handleAttendance(phone) {
    const linked = await getDb(`sabuj/telegram_users/${encodeKey(phone)}`);
    if (!linked?.appId) { await sendMessage(phone, `❌ লিঙ্ক নেই। *!link* দিয়ে লিঙ্ক করুন।`); return; }
    const app = await getDb(`sabuj/applications/${linked.appId}`);
    if (!app) { await sendMessage(phone, '❌ তথ্য পাওয়া যায়নি।'); return; }
    const att = app.attendance;
    if (att?.present !== undefined) {
        const p = att.present || 0, a = att.absent || 0, t = p + a;
        await sendMessage(phone, `📋 *অ্যাটেনডেন্স — ${app.personal?.nameBn || 'শিক্ষার্থী'}*\n\n━━━━━━━━━━━━━━━━━━\n✅ উপস্থিত: ${p} দিন\n❌ অনুপস্থিত: ${a} দিন\n📊 হাজিরা: ${t > 0 ? Math.round(p/t*100) : 0}%\n━━━━━━━━━━━━━━━━━━`);
    } else {
        await sendMessage(phone, `📋 অ্যাটেনডেন্স তথ্য আপডেট হচ্ছে।\nhttps://sabujcomputers.pro.bd/portal.html`);
    }
}

async function handleReceipt(phone) {
    const linked = await getDb(`sabuj/telegram_users/${encodeKey(phone)}`);
    if (!linked?.appId) { await sendMessage(phone, `❌ লিঙ্ক নেই। *!link* দিয়ে লিঙ্ক করুন।`); return; }
    const app = await getDb(`sabuj/applications/${linked.appId}`);
    if (!app) { await sendMessage(phone, '❌ তথ্য পাওয়া যায়নি।'); return; }
    const { total = 0, paid = 0, due = 0 } = app.payment || {};
    await sendMessage(phone,
        `━━━━━━━━━━━━━━━━━━━━━━\n🧾 *DIGITAL RECEIPT*\n   সবুজ কম্পিউটার ট্রেনিং সেন্টার\n━━━━━━━━━━━━━━━━━━━━━━\n📅 ${nowStr()}\n👤 ${app.personal?.nameEn || 'Student'}\n🆔 ${app.regNo || 'N/A'}\n━━━━━━━━━━━━━━━━━━━━━━\n💰 মোট: ৳${total}\n✅ পরিশোধিত: ৳${paid}\n⚠️ বকেয়া: ৳${due}\n━━━━━━━━━━━━━━━━━━━━━━`
    );
}

async function handleUnlink(phone) {
    if (await getDb(`sabuj/telegram_users/${encodeKey(phone)}`)) {
        await deleteDb(`sabuj/telegram_users/${encodeKey(phone)}`);
        await sendMessage(phone, `✅ অ্যাকাউন্ট আনলিঙ্ক হয়েছে। *!link* দিয়ে পুনরায় লিঙ্ক করুন।`);
    } else {
        await sendMessage(phone, '⚠️ আগে থেকেই লিঙ্ক নেই।');
    }
}

async function handleTalkAdmin(phone, text, senderName, state) {
    state.awaiting = '';
    if (!ADMIN_PHONE) { await sendMessage(phone, '⚠️ Admin নেই। ফোন: 01724-084350'); return; }
    await sendMessage(ADMIN_PHONE,
        `📨 *সাপোর্ট মেসেজ*\n\n👤 ${senderName || 'অজানা'}\n📱 ${phone}\n[REPLYTO:${phone}]\n\n💬 ${text}`
    );
    await sendMessage(phone, `✅ মেসেজ পাঠানো হয়েছে। রিপ্লাই এখানেই আসবে। ⏳`);
}

// Admin commands
async function handleBroadcast(phone, text) {
    if (!isAdmin(phone)) { await sendMessage(phone, '❌ Admin পারমিশন নেই।'); return; }
    const msg = text.split(' ').slice(1).join(' ');
    if (!msg) { await sendMessage(phone, 'নিয়ম: `!broadcast মেসেজ`'); return; }
    const users = await getDb('sabuj/telegram_users');
    if (!users) { await sendMessage(phone, 'কোনো লিঙ্কড ইউজার নেই।'); return; }
    let ok = 0, fail = 0;
    for (const [, u] of Object.entries(users)) {
        if (!u.phone) { fail++; continue; }
        try { await sendMessage(u.phone, `📢 *সেন্টার বিজ্ঞপ্তি:*\n\n${msg}`); ok++; } catch { fail++; }
    }
    await sendMessage(phone, `📊 Broadcast: ✅ ${ok} সফল, ❌ ${fail} ব্যর্থ`);
}

async function handleAddNotice(phone, text) {
    if (!isAdmin(phone)) { await sendMessage(phone, '❌ Admin পারমিশন নেই।'); return; }
    const parts = text.split(' ').slice(1).join(' ');
    if (!parts) { await sendMessage(phone, 'নিয়ম: `!add_notice টাইটেল | বিবরণ`'); return; }
    const seg = parts.split('|');
    const title = seg.length > 1 ? seg[0].trim() : 'নতুন নোটিশ';
    const details = seg.length > 1 ? seg[1].trim() : seg[0].trim();
    await putDb(`sabuj/notices/t${nowTs()}`, { title, details, date: nowStr() });
    const users = await getDb('sabuj/telegram_users');
    let ok = 0;
    if (users) for (const [, u] of Object.entries(users)) {
        if (!u.phone) continue;
        try { await sendMessage(u.phone, `📌 *নতুন নোটিশ: ${title}*\n\n${details}`); ok++; } catch {}
    }
    await sendMessage(phone, `✅ নোটিশ সংরক্ষিত, ${ok} জনকে পাঠানো হয়েছে।`);
}

async function handleDeleteNotice(phone, text) {
    if (!isAdmin(phone)) { await sendMessage(phone, '❌ Admin পারমিশন নেই।'); return; }
    const key = text.split(' ')[1];
    if (!key) {
        const notices = await getDb('sabuj/notices');
        if (!notices) { await sendMessage(phone, 'কোনো নোটিশ নেই।'); return; }
        let list = `📋 *নোটিশ তালিকা:*\n\n`;
        for (const [k, n] of Object.entries(notices).slice(0, 10)) list += `🔑 \`${k}\` — ${n.title || ''}\n`;
        list += `\n\`!delete_notice <key>\``;
        await sendMessage(phone, list); return;
    }
    const ok = await deleteDb(`sabuj/notices/${key}`);
    await sendMessage(phone, ok ? `✅ মুছে ফেলা হয়েছে।` : `❌ সমস্যা হয়েছে।`);
}

async function handleVerifyStudent(phone, text) {
    if (!isAdmin(phone)) { await sendMessage(phone, '❌ Admin পারমিশন নেই।'); return; }
    const search = text.split(' ')[1];
    if (!search) { await sendMessage(phone, 'নিয়ম: `!verify_student <RegNo বা Phone>`'); return; }
    const apps = (await getDb('sabuj/applications')) || {};
    for (const [, d] of Object.entries(apps)) {
        if (search === String(d.regNo || '') || search === String(d.personal?.phone || '')) {
            await sendMessage(phone,
                `✅ *স্টুডেন্ট তথ্য*\n\n━━━━━━━━━━━━━━━━━━\n👤 ${d.personal?.nameBn || 'N/A'}\n🆔 ${d.regNo || 'N/A'}\n📞 ${d.personal?.phone || 'N/A'}\n🎓 ${d.enrollment?.courseId || 'N/A'}\n━━━━━━━━━━━━━━━━━━\n✅ ৳${d.payment?.paid || 0}\n⚠️ ৳${d.payment?.due || 0}`
            ); return;
        }
    }
    await sendMessage(phone, '❌ পাওয়া যায়নি।');
}

async function handleStats(phone) {
    if (!isAdmin(phone)) { await sendMessage(phone, '❌ Admin পারমিশন নেই।'); return; }
    const [apps, users, notices] = await Promise.all([getDb('sabuj/applications'), getDb('sabuj/telegram_users'), getDb('sabuj/notices')]);
    let totalDue = 0, totalPaid = 0;
    for (const a of Object.values(apps || {})) { totalDue += Number(a.payment?.due || 0); totalPaid += Number(a.payment?.paid || 0); }
    await sendMessage(phone,
        `📊 *পরিসংখ্যান*\n\n━━━━━━━━━━━━━━━━━━\n👨‍🎓 শিক্ষার্থী: ${Object.keys(apps || {}).length}\n🔗 লিঙ্কড: ${Object.keys(users || {}).length}\n📢 নোটিশ: ${Object.keys(notices || {}).length}\n━━━━━━━━━━━━━━━━━━\n✅ ৳${totalPaid}\n⚠️ ৳${totalDue}\n━━━━━━━━━━━━━━━━━━\n🕐 ${nowStr()}`
    );
}

async function handleAI(phone, text, state) {
    if (!aiClient) { await sendMessage(phone, '⚠️ AI unavailable.'); return; }
    try {
        const botSettings = (await getDb('sabuj/bot_settings')) || {};
        const model = aiClient.getGenerativeModel({ model: 'gemini-1.5-flash', systemInstruction: botSettings.system_prompt || DEFAULT_SYSTEM_PROMPT, generationConfig: { temperature: 0.35, maxOutputTokens: 512 } });
        const chat  = model.startChat({ history: state.chatHistory || [] });
        const result = await chat.sendMessage(text);
        const reply  = result.response.text().trim() || 'দুঃখিত, উত্তর পাওয়া যায়নি।';
        state.chatHistory = [...(state.chatHistory || []), { role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: reply }] }].slice(-(MAX_HISTORY_TURNS * 2));
        await sendMessage(phone, reply);
    } catch (e) {
        console.error('Gemini error:', e.message);
        await sendMessage(phone, '⚠️ AI সমস্যা। মেনু: *!menu*');
    }
}

// ── Webhook Verification (GET) ──
app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
        console.log('✅ Webhook verified!');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ── Message Receiver (POST) ──
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Meta কে সাথে সাথে 200 দিতে হবে
    try {
        const value = req.body?.entry?.[0]?.changes?.[0]?.value;
        if (!value?.messages) return;

        const msg        = value.messages[0];
        const phone      = msg.from;
        const senderName = value.contacts?.[0]?.profile?.name || '';

        if (msg.type !== 'text') {
            await sendMessage(phone, `দুঃখিত, শুধু text message সমর্থিত। *!menu* লিখুন।`);
            return;
        }

        const text  = msg.text.body.trim();
        const state = getState(phone);

        if (!isAdmin(phone) && isRateLimited(phone)) {
            await sendMessage(phone, '⏳ একটু থামুন! কিছুক্ষণ পর আবার চেষ্টা করুন।');
            return;
        }

        // Admin reply forwarding: "reply 8801XXXXXXXXX মেসেজ"
        if (isAdmin(phone) && text.toLowerCase().startsWith('reply ')) {
            const parts = text.split(' ');
            const target = parts[1], reply = parts.slice(2).join(' ');
            if (target && reply) {
                await sendMessage(target, `🎧 *অ্যাডমিনের রিপ্লাই:*\n\n${reply}`);
                await sendMessage(phone, `✅ রিপ্লাই পাঠানো হয়েছে → ${target}`);
            } else {
                await sendMessage(phone, 'নিয়ম: `reply 8801XXXXXXXXX রিপ্লাই মেসেজ`');
            }
            return;
        }

        if (state.awaiting === 'link_reg')  { await handleLinkAccount(phone, text, state); return; }
        if (state.awaiting === 'talk_admin') { await handleTalkAdmin(phone, text, senderName, state); return; }

        const cmd = text.toLowerCase().split(' ')[0];
        switch (cmd) {
            case '!start': case '!menu': await sendMessage(phone, mainMenuText()); break;
            case '!help':       await sendMessage(phone, helpText()); break;
            case '!courses':    await handleCourses(phone); break;
            case '!fees':       await sendMessage(phone, feesText()); break;
            case '!admission':  await sendMessage(phone, admissionText()); break;
            case '!results':    await sendMessage(phone, `🏆 *ফলাফল যাচাই*\n\n🔗 https://sabujcomputers.pro.bd/verify.html`); break;
            case '!notice':     await handleNotice(phone); break;
            case '!contact':    await sendMessage(phone, contactText()); break;
            case '!link':
                state.awaiting = 'link_reg';
                await sendMessage(phone, `🔗 *অ্যাকাউন্ট লিঙ্ক*\n\nআপনার *ফোন নম্বর* বা *রেজিস্ট্রেশন নম্বর* পাঠান:\n_(উদাহরণ: 01724084350)_`);
                break;
            case '!due':        await handleDue(phone); break;
            case '!attendance': await handleAttendance(phone); break;
            case '!receipt':    await handleReceipt(phone); break;
            case '!unlink':     await handleUnlink(phone); break;
            case '!admin':
                state.awaiting = 'talk_admin';
                await sendMessage(phone, `🎧 *অ্যাডমিনের সাথে কথা বলুন*\n\nআপনার মেসেজ লিখুন। অ্যাডমিন শীঘ্রই রিপ্লাই দেবেন। ⏳`);
                break;
            case '!broadcast':      await handleBroadcast(phone, text); break;
            case '!add_notice':     await handleAddNotice(phone, text); break;
            case '!delete_notice':  await handleDeleteNotice(phone, text); break;
            case '!verify_student': await handleVerifyStudent(phone, text); break;
            case '!stats':          await handleStats(phone); break;
            default:
                if (!text.startsWith('!') && aiClient) await handleAI(phone, text, state);
                else if (text.startsWith('!')) await sendMessage(phone, `❓ কমান্ড চেনা নেই। *!help* লিখুন।`);
                else await sendMessage(phone, `মেনু দেখতে *!menu* লিখুন।`);
        }
    } catch (e) {
        console.error('Webhook error:', e.message);
    }
});

app.get('/', (req, res) => res.send('✅ সবুজ কম্পিউটার্স WhatsApp Bot (Meta Cloud API) চলছে!'));

app.listen(PORT, () => {
    console.log(`\n✅ সবুজ কম্পিউটার্স WhatsApp Bot চালু! Port: ${PORT}`);
    console.log(`\n📋 Environment Check:`);
    console.log(`   WA_TOKEN:        ${WA_TOKEN        ? '✅' : '❌ Missing'}`);
    console.log(`   WA_PHONE_ID:     ${WA_PHONE_ID     ? '✅' : '❌ Missing'}`);
    console.log(`   WA_VERIFY_TOKEN: ${WA_VERIFY_TOKEN ? '✅' : '❌ Missing'}`);
    console.log(`   ADMIN_PHONE:     ${ADMIN_PHONE     ? '✅' : '❌ Missing'}`);
    console.log(`   GEMINI_API_KEY:  ${GEMINI_API_KEY  ? '✅' : '❌ Missing'}`);
    console.log(`   FIREBASE_URL:    ${FIREBASE_URL    ? '✅' : '❌ Missing'}`);
});
