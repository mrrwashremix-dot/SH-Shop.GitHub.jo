require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const db = new Database("marketplace.db");
const PORT = Number(process.env.PORT || 3000);
const COMMISSION_PERCENT = Math.max(0, Math.min(100, Number(process.env.COMMISSION_PERCENT || 5)));
const SITE_NAME = process.env.SITE_NAME || "SH Market";
const PRIVATE_UPLOAD_DIR = path.join(__dirname, "private_uploads");
fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "សាកល្បងច្រើនដងពេក។ សូមរង់ចាំ 15 នាទី។" } });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "អ្នកផ្ញើសារញឹកញាប់ពេក។ សូមសាកម្ដងទៀតពេលក្រោយ។" } });
app.use(express.static(path.join(__dirname, "public")));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS chat_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_one INTEGER NOT NULL,
    user_two INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_one, user_two),
    CHECK(user_one < user_two),
    FOREIGN KEY(user_one) REFERENCES users(id),
    FOREIGN KEY(user_two) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message_text TEXT DEFAULT '',
    image_name TEXT DEFAULT '',
    image_mime TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_name TEXT NOT NULL,
    seller_user_id INTEGER,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    price REAL NOT NULL CHECK(price >= 0),
    image_url TEXT DEFAULT '',
    verification_status TEXT NOT NULL DEFAULT 'pending',
    verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_contact TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price REAL NOT NULL,
    total REAL NOT NULL,
    commission REAL NOT NULL,
    buyer_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    shipped_at TEXT,
    delivered_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id)
  );
  CREATE TABLE IF NOT EXISTS product_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    reporter_user_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    details TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(reporter_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS product_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    buyer_user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL UNIQUE,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(buyer_user_id) REFERENCES users(id),
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );
`);
// Safe schema migration for databases created by earlier starter versions.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("users", "role", "TEXT NOT NULL DEFAULT 'user'");
ensureColumn("products", "seller_user_id", "INTEGER");
ensureColumn("products", "verification_status", "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn("products", "verified_at", "TEXT");
ensureColumn("orders", "buyer_user_id", "INTEGER");
ensureColumn("orders", "payment_status", "TEXT NOT NULL DEFAULT 'unpaid'");
ensureColumn("orders", "shipped_at", "TEXT");
ensureColumn("orders", "delivered_at", "TEXT");

// Optional first administrator is created from private environment variables; never hard-code credentials.
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 12) {
  const adminName = String(process.env.ADMIN_USERNAME).trim();
  if (/^[A-Za-z0-9_]{3,24}$/.test(adminName)) {
    const existing = db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").get(adminName);
    if (!existing) {
      const salt = crypto.randomBytes(16).toString("hex");
      const digest = crypto.scryptSync(process.env.ADMIN_PASSWORD, salt, 64).toString("hex");
      db.prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?, 'admin')").run(adminName, `${salt}:${digest}`);
    } else {
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(existing.id);
    }
  }
}


// Private buyer/seller chat. Images are stored outside public/ and only served to thread members.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function issueToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO auth_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return token;
}
function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token.length > 200) return res.status(401).json({ error: "សូមចូលគណនីជាមុនសិន។" });
  const session = db.prepare("SELECT u.id, u.username, u.role, t.token_hash FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.expires_at>? ").get(hashToken(token), Date.now());
  if (!session) return res.status(401).json({ error: "សម័យចូលគណនីផុតកំណត់។ សូមចូលម្ដងទៀត។" });
  req.user = { id: session.id, username: session.username, role: session.role };
  req.tokenHash = session.token_hash;
  next();
}
function adminOnly(req, res, next) { if (req.user?.role !== "admin") return res.status(403).json({error:"ត្រូវការសិទ្ធិ Admin។"}); next(); }
function isThreadMember(threadId, userId) {
  return db.prepare("SELECT id FROM chat_threads WHERE id=? AND (user_one=? OR user_two=?)").get(threadId, userId, userId);
}
function imageSignature(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0]===0xff && buffer[1]===0xd8 && buffer[2]===0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii",0,4)==="RIFF" && buffer.toString("ascii",8,12)==="WEBP") return "image/webp";
  if (buffer.length >= 6 && ["GIF87a","GIF89a"].includes(buffer.toString("ascii",0,6))) return "image/gif";
  return null;
}
app.post("/api/auth/register", authLimiter, (req,res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return res.status(400).json({error:"ឈ្មោះគណនីត្រូវមាន 3–24 តួអក្សរ អក្សរអង់គ្លេស លេខ ឬ _។"});
  if (password.length < 10 || password.length > 200) return res.status(400).json({error:"ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 10 តួអក្សរ។"});
  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const digest = crypto.scryptSync(password, salt, 64).toString("hex");
    const result = db.prepare("INSERT INTO users (username,password_hash) VALUES (?,?)").run(username, `${salt}:${digest}`);
    res.status(201).json({token:issueToken(result.lastInsertRowid), user:{id:Number(result.lastInsertRowid),username,role:"user"}});
  } catch (e) { if (String(e.message).includes("UNIQUE")) return res.status(409).json({error:"ឈ្មោះគណនីនេះមានអ្នកប្រើរួចហើយ។"}); throw e; }
});
app.post("/api/auth/login", authLimiter, (req,res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username);
  let ok = false;
  if (user) { const [salt, expectedHex] = user.password_hash.split(":"); const actual = crypto.scryptSync(password, salt, 64); const expected = Buffer.from(expectedHex,"hex"); ok = actual.length===expected.length && crypto.timingSafeEqual(actual,expected); }
  if (!ok) return res.status(401).json({error:"ឈ្មោះគណនី ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ។"});
  res.json({token:issueToken(user.id),user:{id:user.id,username:user.username,role:user.role || "user"}});
});
app.get("/api/auth/me", auth, (req,res) => res.json({user:req.user}));
app.post("/api/auth/logout", auth, (req,res) => { db.prepare("DELETE FROM auth_tokens WHERE token_hash=?").run(req.tokenHash); res.json({ok:true}); });
app.get("/api/chat/users", auth, (req,res) => {
  const q = String(req.query.q || "").trim().replace(/[^A-Za-z0-9_]/g, "").slice(0,24);
  if (q.length < 3) return res.json({users:[]});
  const users = db.prepare("SELECT id, username FROM users WHERE username LIKE ? COLLATE NOCASE AND id<>? ORDER BY username LIMIT 10").all(`%${q}%`, req.user.id);
  res.json({users});
});
app.get("/api/chats", auth, (req,res) => {
  const rows = db.prepare(`SELECT t.id, u.id AS other_user_id, u.username AS other_username,
    (SELECT message_text FROM chat_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_message,
    (SELECT image_name FROM chat_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_image,
    (SELECT created_at FROM chat_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_at
    FROM chat_threads t JOIN users u ON u.id=CASE WHEN t.user_one=? THEN t.user_two ELSE t.user_one END
    WHERE t.user_one=? OR t.user_two=? ORDER BY COALESCE(last_at,t.created_at) DESC`).all(req.user.id,req.user.id,req.user.id);
  res.json({chats:rows});
});
app.post("/api/chats", auth, (req,res) => {
  const username = String(req.body?.username || "").trim();
  const other = db.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE").get(username);
  if (!other || other.id===req.user.id) return res.status(404).json({error:"រកមិនឃើញគណនីអ្នកប្រើផ្សេងនេះទេ។"});
  const a=Math.min(req.user.id,other.id), b=Math.max(req.user.id,other.id);
  db.prepare("INSERT OR IGNORE INTO chat_threads (user_one,user_two) VALUES (?,?)").run(a,b);
  const thread=db.prepare("SELECT id FROM chat_threads WHERE user_one=? AND user_two=?").get(a,b);
  res.status(201).json({chat:{id:thread.id,other_username:other.username}});
});
app.get("/api/chats/:id/messages", auth, (req,res) => {
  const id=Number(req.params.id);
  if (!Number.isInteger(id) || !isThreadMember(id,req.user.id)) return res.status(404).json({error:"រកមិនឃើញបន្ទប់ជជែកនេះទេ។"});
  const messages=db.prepare("SELECT id,sender_id,message_text,image_name,image_mime,created_at FROM chat_messages WHERE thread_id=? ORDER BY id ASC LIMIT 300").all(id);
  res.json({messages:messages.map(m=>({...m,imageUrl:m.image_name?`/api/chat-images/${m.id}`:null}))});
});
app.post("/api/chats/:id/messages", auth, chatLimiter, (req,res) => {
  const id=Number(req.params.id), message=String(req.body?.text || "").trim();
  if (!Number.isInteger(id) || !isThreadMember(id,req.user.id)) return res.status(404).json({error:"រកមិនឃើញបន្ទប់ជជែកនេះទេ។"});
  if (!message || message.length>2000) return res.status(400).json({error:"សារត្រូវមានពី 1 ដល់ 2000 តួអក្សរ។"});
  const result=db.prepare("INSERT INTO chat_messages (thread_id,sender_id,message_text) VALUES (?,?,?)").run(id,req.user.id,message);
  res.status(201).json({id:Number(result.lastInsertRowid)});
});
app.post("/api/chats/:id/images", auth, chatLimiter, (req,res) => {
  upload.single("image")(req,res,err=>{
    if (err) return res.status(400).json({error:err.code==="LIMIT_FILE_SIZE"?"រូបភាពធំពេក។ អតិបរមា 5MB។":"មិនអាចទទួលឯកសារនេះបានទេ។"});
    const id=Number(req.params.id);
    if (!Number.isInteger(id) || !isThreadMember(id,req.user.id)) return res.status(404).json({error:"រកមិនឃើញបន្ទប់ជជែកនេះទេ។"});
    if (!req.file) return res.status(400).json({error:"សូមជ្រើសរើសរូបភាពជាមុន។"});
    const mime=imageSignature(req.file.buffer);
    if (!mime || !["image/jpeg","image/png","image/webp","image/gif"].includes(mime)) return res.status(400).json({error:"អនុញ្ញាតតែរូបភាព JPG, PNG, WEBP ឬ GIF ប៉ុណ្ណោះ។"});
    const filename=crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(path.join(PRIVATE_UPLOAD_DIR,filename),req.file.buffer,{flag:"wx",mode:0o600});
    const caption=String(req.body?.text || "").trim().slice(0,500);
    const result=db.prepare("INSERT INTO chat_messages (thread_id,sender_id,message_text,image_name,image_mime) VALUES (?,?,?,?,?)").run(id,req.user.id,caption,filename,mime);
    res.status(201).json({id:Number(result.lastInsertRowid),imageUrl:`/api/chat-images/${result.lastInsertRowid}`});
  });
});
app.get("/api/chat-images/:messageId", auth, (req,res) => {
  const mid=Number(req.params.messageId);
  const msg=db.prepare("SELECT thread_id,image_name,image_mime FROM chat_messages WHERE id=?").get(mid);
  if (!msg || !msg.image_name || !isThreadMember(msg.thread_id,req.user.id)) return res.status(404).json({error:"មិនអាចរកឃើញរូបភាពនេះទេ។"});
  const fullPath=path.join(PRIVATE_UPLOAD_DIR,msg.image_name);
  if (!fs.existsSync(fullPath)) return res.status(404).end();
  res.set({"Content-Type":msg.image_mime,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"});
  fs.createReadStream(fullPath).pipe(res);
});

let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `សូមស្វាគមន៍មកកាន់ ${SITE_NAME}! Bot នេះប្រើសម្រាប់ជូនដំណឹងការកុម្ម៉ង់។`);
  });
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `ពាក្យបញ្ជា ${SITE_NAME}:\n/start — ស្វាគមន៍\n/sell — របៀបបង្កើតគណនី និងដាក់ទំនិញ\n/products — បញ្ជីទំនិញថ្មីៗ\n/orders — ការកុម្ម៉ង់ថ្មីៗ (Admin ប៉ុណ្ណោះ)`);
  });
  bot.onText(/\/sell/, (msg) => {
    bot.sendMessage(msg.chat.id, `ដើម្បីដាក់ទំនិញលក់លើ ${SITE_NAME}:\n1. បើកវេបសាយ ហើយចូលផ្នែក «ជជែកផ្ទាល់»។\n2. បង្កើតគណនី ឬចូលគណនី (ឈ្មោះ 3–24 តួ និងពាក្យសម្ងាត់យ៉ាងតិច 10 តួ)។\n3. ទៅ «ដាក់លក់» បញ្ចូលឈ្មោះទំនិញ ការពិពណ៌នា និងតម្លៃ USD។\n4. អ្នកទិញអាចមើលការវាយតម្លៃ និងដាក់ការវាយតម្លៃក្រោយកុម្ម៉ង់។\nកុំបង្ហោះព័ត៌មានសម្ងាត់ ឬអះអាងគុណភាពដែលមិនអាចបញ្ជាក់បាន។`);
  });
  bot.onText(/\/products/, (msg) => {
    const rows = db.prepare("SELECT title, price, seller_name FROM products ORDER BY id DESC LIMIT 10").all();
    const body = rows.length ? rows.map(p => `• ${p.title} — $${Number(p.price).toFixed(2)} (អ្នកលក់: ${p.seller_name})`).join("\n") : "មិនទាន់មានទំនិញទេ។";
    bot.sendMessage(msg.chat.id, body);
  });
  bot.onText(/\/orders/, (msg) => {
    if (String(msg.chat.id) !== String(process.env.TELEGRAM_ADMIN_CHAT_ID || "")) return bot.sendMessage(msg.chat.id, "ពាក្យបញ្ជានេះសម្រាប់ Admin ប៉ុណ្ណោះ។");
    const rows = db.prepare(
      "SELECT id, buyer_name, total, commission, status, created_at FROM orders ORDER BY id DESC LIMIT 10"
    ).all();
    const body = rows.length
      ? rows.map(o => `#${o.id} | ${o.buyer_name} | $${o.total.toFixed(2)} | ជើងសារ $${o.commission.toFixed(2)} | ${o.status}`).join("\\n")
      : "មិនទាន់មានការកុម្ម៉ង់ទេ។";
    bot.sendMessage(msg.chat.id, body);
  });
  bot.on("polling_error", (err) => console.error("Telegram polling error:", err.message));
}

function notifyTelegram(message) {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (bot && chatId) bot.sendMessage(chatId, message).catch(err => console.error("Telegram send error:", err.message));
}

app.get("/api/config", (_req, res) => {
  res.json({ siteName: SITE_NAME, commissionPercent: COMMISSION_PERCENT });
});

app.get("/api/products", (_req, res) => {
  const rows = db.prepare(`SELECT p.*, COALESCE(AVG(r.rating),0) AS average_rating, COUNT(r.id) AS review_count
    FROM products p LEFT JOIN product_reviews r ON r.product_id=p.id
    GROUP BY p.id ORDER BY p.id DESC`).all();
  res.json(rows);
});
app.post("/api/products", auth, (req, res) => {
  const { title, description = "", price, imageUrl = "" } = req.body || {};
  const numericPrice = Number(price);
  if (!title?.trim() || title.trim().length > 120 || !Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice > 100000000) {
    return res.status(400).json({ error: "សូមបំពេញឈ្មោះទំនិញ (មិនលើស 120 តួ) និងតម្លៃធំជាង 0 ឱ្យត្រឹមត្រូវ។" });
  }
  if (String(description).length > 2000) return res.status(400).json({error:"ការពិពណ៌នាមិនអាចលើស 2000 តួអក្សរ។"});
  const image = String(imageUrl || "").trim();
  if (image && (!/^https:\/\//i.test(image) || image.length > 1000)) return res.status(400).json({error:"តំណរូបភាពត្រូវចាប់ផ្ដើមដោយ https:// និងមិនលើស 1000 តួ។"});
  const result = db.prepare(
    "INSERT INTO products (seller_name, seller_user_id, title, description, price, image_url) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(req.user.username, req.user.id, title.trim(), String(description).trim(), numericPrice, image);
  notifyTelegram(`🆕 ទំនិញថ្មី #${result.lastInsertRowid}\n${title.trim()} — $${numericPrice.toFixed(2)}\nអ្នកលក់: @${req.user.username}`);
  res.status(201).json({ id: Number(result.lastInsertRowid), message: "បានដាក់ទំនិញជោគជ័យ។" });
});
app.get("/api/products/:id/reviews", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({error:"លេខទំនិញមិនត្រឹមត្រូវ។"});
  const reviews = db.prepare(`SELECT r.id,r.rating,r.comment,r.created_at,u.username AS reviewer
    FROM product_reviews r JOIN users u ON u.id=r.buyer_user_id WHERE r.product_id=? ORDER BY r.id DESC LIMIT 100`).all(id);
  res.json({reviews});
});
app.post("/api/products/:id/reviews", auth, (req, res) => {
  const productId = Number(req.params.id), rating = Number(req.body?.rating), comment = String(req.body?.comment || "").trim();
  if (!Number.isInteger(productId) || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length > 1000) return res.status(400).json({error:"ជ្រើសរើសពិន្ទុ 1–5 ហើយកុំឱ្យមតិយោបល់លើស 1000 តួ។"});
  const product = db.prepare("SELECT id FROM products WHERE id=?").get(productId);
  if (!product) return res.status(404).json({error:"រកមិនឃើញទំនិញនេះទេ។"});
  const owner = db.prepare("SELECT seller_user_id FROM products WHERE id=?").get(productId);
  if (owner?.seller_user_id === req.user.id) return res.status(403).json({error:"អ្នកលក់មិនអាចវាយតម្លៃទំនិញរបស់ខ្លួនឯងបានទេ។"});
  const order = db.prepare(`SELECT o.id FROM orders o LEFT JOIN product_reviews r ON r.order_id=o.id
    WHERE o.product_id=? AND o.buyer_user_id=? AND o.status='delivered' AND r.id IS NULL ORDER BY o.id DESC LIMIT 1`).get(productId, req.user.id);
  if (!order) return res.status(403).json({error:"អាចវាយតម្លៃបានតែក្រោយ Admin/អ្នកលក់បញ្ជាក់ថាបានទទួលទំនិញ (ស្ថានភាព delivered) ហើយតាម SH Market ប៉ុណ្ណោះ។"});
  try {
    db.prepare("INSERT INTO product_reviews (product_id,buyer_user_id,order_id,rating,comment) VALUES (?,?,?,?,?)").run(productId,req.user.id,order.id,rating,comment);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({error:"ការកុម្ម៉ង់នេះបានវាយតម្លៃរួចហើយ។"});
    throw e;
  }
  res.status(201).json({message:"អរគុណសម្រាប់ការវាយតម្លៃ។"});
});

app.post("/api/orders", auth, (req, res) => {
  const { productId, buyerName, buyerContact, quantity = 1 } = req.body || {};
  const qty = Number(quantity);
  if (!Number.isInteger(Number(productId)) || !buyerName?.trim() || !buyerContact?.trim() || !Number.isInteger(qty) || qty < 1 || qty > 99) {
    return res.status(400).json({ error: "សូមបំពេញព័ត៌មានអ្នកទិញ និងចំនួនទំនិញឱ្យត្រឹមត្រូវ។" });
  }
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(Number(productId));
  if (!product) return res.status(404).json({ error: "រកមិនឃើញទំនិញនេះទេ។" });

  const total = Number((product.price * qty).toFixed(2));
  const commission = Number((total * COMMISSION_PERCENT / 100).toFixed(2));
  const result = db.prepare(
    "INSERT INTO orders (product_id, buyer_name, buyer_contact, quantity, unit_price, total, commission, buyer_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(product.id, buyerName.trim(), buyerContact.trim(), qty, product.price, total, commission, req.user.id);

  notifyTelegram(
    `🛒 ការកុម្ម៉ង់ថ្មី #${result.lastInsertRowid}\\n` +
    `ទំនិញ: ${product.title}\\nអ្នកលក់: ${product.seller_name}\\n` +
    `អ្នកទិញ: ${buyerName.trim()}\\nទំនាក់ទំនង: ${buyerContact.trim()}\\n` +
    `ចំនួន: ${qty}\\nសរុប: $${total.toFixed(2)}\\n` +
    `កម្រៃជើងសារ (${COMMISSION_PERCENT}%): $${commission.toFixed(2)}\\nស្ថានភាព: pending`
  );
  res.status(201).json({ orderId: result.lastInsertRowid, total, commission, message: "បានទទួលការកុម្ម៉ង់ (សាកល្បង)។" });
});

// Buyer and seller order tracking. Payment confirmation here is manual bookkeeping, not a real payment gateway.
app.get("/api/my/orders", auth, (req,res) => {
  const rows = db.prepare(`SELECT o.*, p.title, p.seller_name, p.seller_user_id, u.username AS buyer_username
    FROM orders o JOIN products p ON p.id=o.product_id LEFT JOIN users u ON u.id=o.buyer_user_id
    WHERE o.buyer_user_id=? OR p.seller_user_id=? ORDER BY o.id DESC LIMIT 100`).all(req.user.id, req.user.id);
  res.json({orders:rows});
});
app.post("/api/orders/:id/payment-notice", auth, (req,res) => {
  const id=Number(req.params.id), order=db.prepare("SELECT id,buyer_user_id,payment_status FROM orders WHERE id=?").get(id);
  if(!order) return res.status(404).json({error:"រកមិនឃើញការកុម្ម៉ង់។"});
  if(order.buyer_user_id!==req.user.id) return res.status(403).json({error:"មានតែអ្នកទិញដែលបានកុម្ម៉ង់ប៉ុណ្ណោះអាចជូនដំណឹងនេះបាន។"});
  if(order.payment_status==="confirmed") return res.status(409).json({error:"ការទូទាត់នេះត្រូវបាន Admin បញ្ជាក់រួចហើយ។"});
  db.prepare("UPDATE orders SET payment_status='awaiting_confirmation' WHERE id=?").run(id);
  notifyTelegram(`💳 ស្នើសុំបញ្ជាក់ការទូទាត់ការកុម្ម៉ង់ #${id}\nសូម Admin ផ្ទៀងផ្ទាត់តាមប្រភពទូទាត់ពិត មុនបញ្ជាក់។`);
  res.json({message:"បានជូនដំណឹងទៅ Admin។ សូមរង់ចាំការផ្ទៀងផ្ទាត់; ស្ថានភាពនេះមិនមែនជាភស្តុតាងថាប្រាក់បានចូលទេ។"});
});
app.patch("/api/orders/:id/status", auth, (req,res) => {
  const id=Number(req.params.id), status=String(req.body?.status||"");
  const order=db.prepare(`SELECT o.*,p.seller_user_id FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`).get(id);
  if(!order) return res.status(404).json({error:"រកមិនឃើញការកុម្ម៉ង់ទេ។"});
  if(status==="shipped" && order.seller_user_id===req.user.id && order.status==="pending") {
    db.prepare("UPDATE orders SET status='shipped',shipped_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    return res.json({message:"បានកត់ត្រាថាបានផ្ញើទំនិញ។"});
  }
  if(status==="delivered" && order.buyer_user_id===req.user.id && order.status==="shipped") {
    db.prepare("UPDATE orders SET status='delivered',delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    return res.json({message:"បានបញ្ជាក់ថាទទួលទំនិញរួច។ ឥឡូវនេះអ្នកអាចវាយតម្លៃទំនិញបាន។"});
  }
  return res.status(403).json({error:"មិនអាចប្ដូរស្ថានភាពនេះបានទេ។ អ្នកលក់អាចសម្គាល់ថាបានផ្ញើ ហើយអ្នកទិញអាចបញ្ជាក់ការទទួលក្រោយស្ថានភាពបានផ្ញើ។"});
});
app.post("/api/products/:id/report", auth, (req,res) => {
  const productId=Number(req.params.id), reason=String(req.body?.reason||"").trim(), details=String(req.body?.details||"").trim();
  if(!Number.isInteger(productId)||!db.prepare("SELECT id FROM products WHERE id=?").get(productId)) return res.status(404).json({error:"រកមិនឃើញទំនិញនេះទេ។"});
  if(!["quality","misleading","fraud","other"].includes(reason)||details.length>1000) return res.status(400).json({error:"សូមជ្រើសរើសមូលហេតុ និងកុំឱ្យព័ត៌មានលើស 1000 តួ។"});
  const result=db.prepare("INSERT INTO product_reports(product_id,reporter_user_id,reason,details) VALUES(?,?,?,?)").run(productId,req.user.id,reason,details);
  notifyTelegram(`🚩 របាយការណ៍ទំនិញ #${productId}\nមូលហេតុ: ${reason}\nReport #${result.lastInsertRowid}`);
  res.status(201).json({message:"បានផ្ញើរបាយការណ៍ទៅក្រុមត្រួតពិនិត្យ។"});
});
app.get("/api/admin/summary", auth, adminOnly, (_req,res) => {
  res.json({products:db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN verification_status='pending' THEN 1 ELSE 0 END) AS pending FROM products").get(), orders:db.prepare("SELECT COUNT(*) AS total FROM orders").get(), reports:db.prepare("SELECT COUNT(*) AS open FROM product_reports WHERE status='open'").get()});
});
app.get("/api/admin/products", auth, adminOnly, (_req,res) => res.json({products:db.prepare(`SELECT p.*,u.username AS seller_username FROM products p LEFT JOIN users u ON u.id=p.seller_user_id ORDER BY p.id DESC LIMIT 200`).all()}));
app.patch("/api/admin/products/:id/verification", auth, adminOnly, (req,res) => {
  const id=Number(req.params.id), status=String(req.body?.status||"");
  if(!["pending","verified","rejected"].includes(status)) return res.status(400).json({error:"ស្ថានភាពមិនត្រឹមត្រូវ។"});
  const result=db.prepare("UPDATE products SET verification_status=?,verified_at=CASE WHEN ?='verified' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?").run(status,status,id);
  if(!result.changes) return res.status(404).json({error:"រកមិនឃើញទំនិញ។"});
  res.json({message:"បានធ្វើបច្ចុប្បន្នភាពស្ថានភាពផ្ទៀងផ្ទាត់។"});
});
app.get("/api/admin/orders", auth, adminOnly, (_req,res) => res.json({orders:db.prepare(`SELECT o.*,p.title,p.seller_name,u.username AS buyer_username FROM orders o JOIN products p ON p.id=o.product_id LEFT JOIN users u ON u.id=o.buyer_user_id ORDER BY o.id DESC LIMIT 200`).all()}));
app.patch("/api/admin/orders/:id/payment", auth, adminOnly, (req,res) => {
  const id=Number(req.params.id), status=String(req.body?.status||"");
  if(!["unpaid","awaiting_confirmation","confirmed","refunded"].includes(status)) return res.status(400).json({error:"ស្ថានភាពទូទាត់មិនត្រឹមត្រូវ។"});
  const result=db.prepare("UPDATE orders SET payment_status=? WHERE id=?").run(status,id);
  if(!result.changes) return res.status(404).json({error:"រកមិនឃើញការកុម្ម៉ង់។"});
  res.json({message:"បានកត់ត្រាស្ថានភាពទូទាត់។ ចំណាំ៖ នេះជាការបញ្ជាក់ដោយ Admin ដោយដៃ មិនមែន payment gateway ទេ។"});
});
app.get("/api/admin/reports", auth, adminOnly, (_req,res) => res.json({reports:db.prepare(`SELECT r.*,p.title,u.username AS reporter FROM product_reports r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.reporter_user_id ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END,r.id DESC LIMIT 200`).all()}));
app.patch("/api/admin/reports/:id", auth, adminOnly, (req,res) => {
  const status=String(req.body?.status||""); if(!["open","reviewing","resolved","dismissed"].includes(status)) return res.status(400).json({error:"ស្ថានភាពរបាយការណ៍មិនត្រឹមត្រូវ។"});
  const result=db.prepare("UPDATE product_reports SET status=? WHERE id=?").run(status,Number(req.params.id)); if(!result.changes) return res.status(404).json({error:"រកមិនឃើញរបាយការណ៍។"}); res.json({message:"បានធ្វើបច្ចុប្បន្នភាពរបាយការណ៍។"});
});

app.listen(PORT, () => {
  console.log(`${SITE_NAME} running at http://localhost:${PORT}`);
  console.log(`Commission rate: ${COMMISSION_PERCENT}%`);
});
