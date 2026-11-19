const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "europe-west1" });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const MAFIA = ["don", "mafia"];
const NIGHT = { don: "kill", mafia: "kill", doctor: "heal", komisar: "check", prostitute: "block", maniac: "snipe" };
const DUR = { night: 60000, day: 120000 };
const PRICE = { docs: 30, shield: 50 };
const WIN = { mafia: "Перемогла мафія.", civilians: "Перемогли мирні.", maniac: "Переміг маніяк.", none: "Нічия: ніхто не вижив." };

const must = (msg, ok) => { if (!ok) throw new HttpsError("failed-precondition", msg); };
const uidOf = (req) => { if (!req.auth) throw new HttpsError("unauthenticated", "Увійдіть в акаунт"); return req.auth.uid; };
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const tg = (chat, text) => chat && process.env.TG_TOKEN
  ? fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }),
    }).catch(() => {})
  : null;

function buildRoles(n) {
  const r = ["don", "doctor"];
  for (let i = 1; i < Math.max(1, Math.floor(n / 3)); i++) r.push("mafia");
  if (n >= 5) r.push("komisar");
  if (n >= 6) r.push("prostitute");
  if (n >= 7) r.push("maniac");
  while (r.length < n) r.push("civilian");
  return shuffle(r);
}

// ---- Профіль і магазин ----
exports.initUser = onCall(async (req) => {
  const ref = db.doc(`users/${uidOf(req)}`);
  await db.runTransaction(async (t) => { if (!(await t.get(ref)).exists) t.set(ref, { money: 50, docs: 0, shield: 0 }); });
  return { ok: true };
});

exports.buyItem = onCall(async (req) => {
  const uid = uidOf(req), item = req.data.item;
  must("Невідомий товар", PRICE[item]);
  const ref = db.doc(`users/${uid}`);
  await db.runTransaction(async (t) => {
    const u = (await t.get(ref)).data();
    must("Профіль не створено", u);
    must("Недостатньо грошей", u.money >= PRICE[item]);
    t.update(ref, { money: FieldValue.increment(-PRICE[item]), [item]: FieldValue.increment(1) });
  });
  return { ok: true };
});

// ---- Кімнати ----
exports.createRoom = onCall(async (req) => {
  const uid = uidOf(req);
  const r = await db.collection("rooms").add({
    hostId: uid, chatId: null, status: "lobby", phase: null, round: 0, log: [], createdAt: Date.now(),
  });
  return { roomId: r.id };
});

exports.joinRoom = onCall(async (req) => {
  const uid = uidOf(req);
  const ref = db.doc(`rooms/${req.data.roomId}`);
  const name = String(req.data.name || "").trim().slice(0, 20);
  must("Вкажіть нікнейм", name);
  await db.runTransaction(async (t) => {
    const room = (await t.get(ref)).data();
    must("Кімнати не існує", room);
    must("Гра вже почалась", room.status === "lobby");
    t.set(ref.collection("players").doc(uid), { name, alive: true });
    if (!room.hostId) t.update(ref, { hostId: uid });
  });
  return { ok: true };
});

exports.startGame = onCall(async (req) => {
  const uid = uidOf(req);
  const ref = db.doc(`rooms/${req.data.roomId}`);
  let chat = null;
  await db.runTransaction(async (t) => {
    const room = (await t.get(ref)).data();
    must("Кімнати не існує", room);
    must("Тільки хост може почати гру", room.hostId === uid);
    must("Гра вже почалась", room.status === "lobby");
    chat = room.chatId;
    const ps = await t.get(ref.collection("players"));
    must("Потрібно щонайменше 4 гравці", ps.size >= 4);
    const us = await Promise.all(ps.docs.map((d) => t.get(db.doc(`users/${d.id}`))));
    const roles = buildRoles(ps.size);
    const list = ps.docs.map((d, i) => ({ id: d.id, name: d.data().name, role: roles[i], u: us[i].data() || {} }));
    const team = list.filter((p) => MAFIA.includes(p.role)).map((p) => p.name);
    list.forEach((p) => {
      const fake = MAFIA.includes(p.role) && p.u.docs > 0; // «Документи»: комісар побачить мирного
      const shield = p.u.shield > 0;                       // «Захист»: переживе одне вбивство
      t.set(ref.collection("private").doc(p.id), { role: p.role, mates: MAFIA.includes(p.role) ? team : [], notes: [], fake, shield });
      if (fake || shield) t.update(db.doc(`users/${p.id}`), {
        ...(fake && { docs: FieldValue.increment(-1) }), ...(shield && { shield: FieldValue.increment(-1) }),
      });
    });
    t.update(ref, { status: "playing", phase: "night", round: 1, phaseEndsAt: Date.now() + DUR.night, log: ["Гра почалась. Настала ніч."] });
  });
  tg(chat, "Гра почалась. Настала ніч.");
  return { ok: true };
});

// ---- Дії гравців ----
exports.act = onCall(async (req) => {
  const uid = uidOf(req);
  const { roomId } = req.data;
  const target = String(req.data.target);
  const ref = db.doc(`rooms/${roomId}`);
  const [room, me, tgt, pv] = await Promise.all([
    ref.get(), ref.collection("players").doc(uid).get(),
    ref.collection("players").doc(target).get(), ref.collection("private").doc(uid).get(),
  ]);
  must("Гра не йде", room.exists && room.data().status === "playing");
  must("Ви не в грі або вибули", me.exists && me.data().alive);
  must("Ціль недоступна", tgt.exists && tgt.data().alive);
  const { phase, round } = room.data();
  let type;
  if (phase === "day") {
    type = "vote";
    must("Не можна голосувати за себе", target !== uid);
  } else {
    type = NIGHT[pv.data().role];
    must("Вночі ви спите", type);
  }
  await ref.collection("actions").doc(uid).set({ type, target, key: `${round}:${phase}` });
  await tick(roomId);
  return { ok: true };
});

exports.say = onCall(async (req) => {
  const uid = uidOf(req);
  const text = String(req.data.text || "").trim().slice(0, 300);
  must("Порожнє повідомлення", text);
  const ref = db.doc(`rooms/${req.data.roomId}`);
  const [room, me] = await Promise.all([ref.get(), ref.collection("players").doc(uid).get()]);
  must("Чат працює лише вдень", room.exists && room.data().status === "playing" && room.data().phase === "day");
  must("Ви вибули з гри", me.exists && me.data().alive);
  await ref.collection("chat").add({ name: me.data().name, text, ts: Date.now() });
  return { ok: true };
});

exports.forceNext = onCall(async (req) => {
  const uid = uidOf(req);
  const r = (await db.doc(`rooms/${req.data.roomId}`).get()).data();
  must("Тільки хост", r && r.hostId === uid);
  await tick(req.data.roomId, true);
  return { ok: true };
});

// Клієнт викликає, коли таймер дійшов до нуля; сервер сам перевіряє час
exports.poke = onCall(async (req) => { uidOf(req); await tick(req.data.roomId, "timer"); return { ok: true }; });

// Запасний варіант: якщо всі гравці закрили вкладки
exports.sweep = onSchedule("every 1 minutes", async () => {
  const s = await db.collection("rooms").where("status", "==", "playing").get();
  for (const d of s.docs) { const r = d.data(); if (r.phaseEndsAt && r.phaseEndsAt <= Date.now()) await tick(d.id, "timer"); }
});

// ---- Рушій фаз ----
async function tick(roomId, mode = false) {
  const ref = db.doc(`rooms/${roomId}`);
  let note = null;
  await db.runTransaction(async (t) => {
    note = null;
    const room = (await t.get(ref)).data();
    if (!room || room.status !== "playing") return;
    let force = mode === true;
    if (mode === "timer") { if (!room.phaseEndsAt || Date.now() < room.phaseEndsAt) return; force = true; }
    const [ps, pv, ac] = await Promise.all(["players", "private", "actions"].map((c) => t.get(ref.collection(c))));
    const nm = {}, role = {}, priv = {};
    ps.docs.forEach((d) => (nm[d.id] = d.data().name));
    pv.docs.forEach((d) => { priv[d.id] = d.data(); role[d.id] = d.data().role; });
    const alive = ps.docs.filter((d) => d.data().alive).map((d) => d.id);
    const key = `${room.round}:${room.phase}`;
    const acts = {};
    ac.docs.forEach((d) => { if (d.data().key === key) acts[d.id] = d.data(); });
    const pRef = (id) => ref.collection("private").doc(id);

    const dead = [], logs = [];
    if (room.phase === "night") {
      const dons = alive.filter((i) => role[i] === "don");
      const mafs = alive.filter((i) => role[i] === "mafia");
      const need = alive.filter((i) => ["don", "doctor", "komisar", "prostitute", "maniac"].includes(role[i]));
      if (!dons.length) need.push(...mafs);
      if (!force && !need.every((i) => acts[i])) return;

      const hooker = alive.find((i) => role[i] === "prostitute");
      const blocked = hooker && acts[hooker] ? acts[hooker].target : null;
      if (blocked) t.update(pRef(blocked), { notes: FieldValue.arrayUnion("Цієї ночі вас відвідала повія: ваша дія скасована.") });
      const pick = (i) => (i && acts[i] && i !== blocked ? acts[i].target : null);

      const killer = [...dons, ...mafs].find((i) => pick(i));
      const kt = killer ? pick(killer) : null;
      const mt = pick(alive.find((i) => role[i] === "maniac"));
      const saved = pick(alive.find((i) => role[i] === "doctor"));

      for (const v of new Set([kt, mt].filter(Boolean))) {
        if (v === saved) continue;
        if (priv[v].shield) { t.update(pRef(v), { shield: false }); logs.push(`${nm[v]} пережив напад.`); continue; }
        dead.push(v);
      }
      if (dead.length) dead.forEach((v) => logs.push(`Вранці знайшли тіло: ${nm[v]}.`));
      else logs.push("Ця ніч минула без жертв.");

      const kom = alive.find((i) => role[i] === "komisar");
      const c = pick(kom);
      if (c) {
        const bad = MAFIA.includes(role[c]) && !priv[c].fake;
        t.update(pRef(kom), { notes: FieldValue.arrayUnion(`${nm[c]} — ${bad ? "мафія" : "мирний"}`) });
        if (priv[c].fake && MAFIA.includes(role[c])) t.update(pRef(c), { fake: false });
      }
    } else {
      if (!force && !alive.every((i) => acts[i])) return;
      const tally = {};
      alive.forEach((i) => { if (acts[i]) tally[acts[i].target] = (tally[acts[i].target] || 0) + 1; });
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const out = top.length && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : null;
      if (out) dead.push(out);
      logs.push(out ? `Місто вигнало: ${nm[out]}.` : "Голоси розділились, ніхто не вибув.");
    }

    dead.forEach((v) => t.update(ref.collection("players").doc(v), { alive: false }));
    const left = alive.filter((i) => !dead.includes(i));
    const m = left.filter((i) => MAFIA.includes(role[i])).length;
    const k = left.filter((i) => role[i] === "maniac").length;
    const win = !left.length ? "none"
      : m === 0 && k === 0 ? "civilians"
      : k === 0 && m >= left.length - m ? "mafia"
      : m === 0 && k > 0 && left.length <= 2 ? "maniac" : null;
    const log = [...room.log, ...logs];

    if (win) {
      const roles = {};
      ps.docs.forEach((d) => (roles[d.id] = { name: nm[d.id], role: role[d.id] }));
      const side = (i) => (MAFIA.includes(role[i]) ? "mafia" : role[i] === "maniac" ? "maniac" : "civilians");
      ps.docs.forEach((d) => t.set(db.doc(`users/${d.id}`), { money: FieldValue.increment(side(d.id) === win ? 30 : 10) }, { merge: true }));
      t.update(ref, { status: "finished", winner: win, roles, log, phaseEndsAt: null });
      logs.push(WIN[win]);
    } else if (room.phase === "night") t.update(ref, { phase: "day", log, phaseEndsAt: Date.now() + DUR.day });
    else t.update(ref, { phase: "night", round: room.round + 1, log, phaseEndsAt: Date.now() + DUR.night });
    note = { chat: room.chatId, text: logs.join("\n") + (win ? "" : room.phase === "night" ? "\nНастав день: обговорюйте й голосуйте." : "\nНастала ніч.") };
  });
  if (note) await tg(note.chat, note.text);
}

// ---- Telegram: бот лише запускає гру ----
exports.telegramWebhook = onRequest(async (req, res) => {
  if (process.env.TG_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== process.env.TG_SECRET) return res.sendStatus(403);
  const m = req.body && req.body.message;
  if (m && m.text && m.text.startsWith("/game")) {
    const room = await db.collection("rooms").add({
      hostId: null, chatId: m.chat.id, status: "lobby", phase: null, round: 0, log: [], createdAt: Date.now(),
    });
    await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: m.chat.id,
        text: "True Mafia: гру створено. Заходьте!",
        reply_markup: { inline_keyboard: [[{ text: "Приєднатися", url: `${process.env.SITE_URL}/#${room.id}` }]] },
      }),
    });
  }
  res.sendStatus(200);
});
