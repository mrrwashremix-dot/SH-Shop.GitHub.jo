const grid = document.querySelector("#productGrid");
const toast = document.querySelector("#toast");
const dialog = document.querySelector("#orderDialog");
let products = [];

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3200);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function renderProducts() {
  if (!products.length) {
    grid.innerHTML = '<div class="product" style="padding:20px;grid-column:1/-1"><h3>មិនទាន់មានទំនិញទេ</h3><p>បង្កើតគណនី ហើយបន្ថែមទំនិញនៅផ្នែក “ដាក់លក់” ខាងក្រោម។</p></div>';
    return;
  }
  grid.innerHTML = products.map(p => `
    <article class="product">
      <img src="${escapeHtml(p.image_url || "https://placehold.co/600x400/eaf0fb/3156a5?text=Product")}" alt="${escapeHtml(p.title)}" onerror="this.src='https://placehold.co/600x400/eaf0fb/3156a5?text=Product'">
      <div class="product-body">
        <h3>${escapeHtml(p.title)}</h3>
        <p class="desc">${escapeHtml(p.description || "ទំនិញពីអ្នកលក់ក្នុង Marketplace។")}</p>
        <div class="price">$${Number(p.price).toFixed(2)}</div>
        <div class="seller">លក់ដោយ៖ @${escapeHtml(p.seller_name)}</div>
        <div class="verification-state">${p.verification_status === "verified" ? "✅ បានផ្ទៀងផ្ទាត់ដោយ Admin" : p.verification_status === "rejected" ? "⚠️ មិនទាន់បានអនុម័ត" : "ℹ️ មិនទាន់ផ្ទៀងផ្ទាត់ដោយ Admin"}</div>
        <div class="rating-summary" aria-label="ការវាយតម្លៃ">⭐ ${Number(p.average_rating || 0).toFixed(1)} / 5 · ${Number(p.review_count || 0)} ការវាយតម្លៃ</div>
        <button type="button" data-review="${p.id}" class="secondary-action">មើល/វាយតម្លៃ</button>
        <button type="button" data-report="${p.id}" class="secondary-action">រាយការណ៍បញ្ហា</button>
        <button type="button" data-order="${p.id}">កុម្ម៉ង់ទំនិញ</button>
      </div>
    </article>`).join("");
  grid.querySelectorAll("[data-order]").forEach(button => button.addEventListener("click", () => {
    if (!chatToken) { showToast("សូមបង្កើតគណនី ឬចូលគណនីជាមុនសិន ដើម្បីកុម្ម៉ង់ និងអាចវាយតម្លៃក្រោយទិញ។"); document.querySelector("#buyerSellerChat").scrollIntoView({behavior:"smooth"}); return; }
    openOrder(Number(button.dataset.order));
  }));
  grid.querySelectorAll("[data-review]").forEach(button => button.addEventListener("click", () => openReview(Number(button.dataset.review))));
  grid.querySelectorAll("[data-report]").forEach(button => button.addEventListener("click", async () => {
    if (!chatToken) { showToast("សូមចូលគណនីជាមុនសិន ដើម្បីរាយការណ៍ទំនិញ។"); document.querySelector("#buyerSellerChat").scrollIntoView({behavior:"smooth"}); return; }
    const reason = prompt("មូលហេតុ៖ quality (គុណភាព), misleading (ព័ត៌មានមិនត្រឹមត្រូវ), fraud (សង្ស័យបោកប្រាស់), other (ផ្សេងៗ)", "quality");
    if (!reason) return;
    const details = prompt("ពណ៌នាបញ្ហា (ស្រេចចិត្ត)", "") || "";
    try { const r = await chatApi(`/api/products/${button.dataset.report}/report`, {method:"POST", body:JSON.stringify({reason:reason.trim().toLowerCase(),details})}); showToast(r.message); }
    catch(err) { showToast(err.message); }
  }));
}
function updateSellerGate() {
  const loggedIn = Boolean(chatToken && chatUser);
  const form = document.querySelector("#productForm");
  const gate = document.querySelector("#sellerGate");
  if (form) form.hidden = !loggedIn;
  if (gate) {
    gate.hidden = loggedIn;
    gate.innerHTML = loggedIn ? "" : '<h3>🔐 ត្រូវចូលគណនីជាមុនសិន</h3><p class="form-note">ទៅផ្នែក «ជជែកផ្ទាល់ជាមួយអ្នកលក់» ដើម្បីបង្កើតគណនី ឬចូលគណនី រួចត្រឡប់មកទីនេះ។</p>';
  }
}
async function load() {
  try {
    const [productsRes, configRes] = await Promise.all([fetch("/api/products"), fetch("/api/config")]);
    products = await productsRes.json();
    const config = await configRes.json();
    document.title = `${config.siteName} | Marketplace`;
    document.querySelector(".brand").innerHTML = `${escapeHtml(config.siteName.split(" ")[0])} <span>${escapeHtml(config.siteName.split(" ").slice(1).join(" ") || "Market")}</span>`;
    document.querySelector("#commissionBadge").textContent = `កម្រៃជើងសារ ${config.commissionPercent}%`;
    renderProducts();
  } catch { grid.innerHTML = "<p>មិនអាចភ្ជាប់ Server បានទេ។ សូមពិនិត្យថា Server កំពុងដំណើរការ។</p>"; }
}
document.querySelector("#productForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!chatToken || !chatUser) return showToast("សូមចូលគណនីមុនដាក់ទំនិញ។");
  const form = new FormData(e.currentTarget);
  const payload = Object.fromEntries(form.entries());
  payload.price = Number(payload.price);
  try {
    const res = await fetch("/api/products", {method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${chatToken}`},body:JSON.stringify(payload)});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "មិនអាចបន្ថែមទំនិញបានទេ");
    e.currentTarget.reset();
    showToast("បានដាក់ទំនិញជោគជ័យ!");
    await load();
  } catch(err) { showToast(err.message); }
});
function openOrder(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  const form = document.querySelector("#orderForm");
  form.elements.productId.value = id;
  document.querySelector("#orderProductName").textContent = `${product.title} — $${Number(product.price).toFixed(2)}`;
  dialog.showModal();
}
document.querySelector("#closeDialog").addEventListener("click", () => dialog.close());
document.querySelector("#orderForm").addEventListener("submit", async e => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  const payload = Object.fromEntries(form.entries());
  payload.productId = Number(payload.productId);
  payload.quantity = Number(payload.quantity);
  try {
    const res = await fetch("/api/orders", {method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${chatToken}`},body:JSON.stringify(payload)});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "កុម្ម៉ង់មិនបានសម្រេច");
    dialog.close();
    e.currentTarget.reset();
    showToast(`ទទួលការកុម្ម៉ង់ #${data.orderId}។ ជើងសារសាកល្បង $${data.commission.toFixed(2)}`);
  } catch(err) { showToast(err.message); }
});
const reviewDialog = document.querySelector("#reviewDialog");
let reviewProductId = null;
async function openReview(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  reviewProductId = id;
  const form = document.querySelector("#reviewForm");
  form.elements.productId.value = id;
  document.querySelector("#reviewProductName").textContent = `${product.title} — $${Number(product.price).toFixed(2)}`;
  const list = document.querySelector("#reviewList"); list.textContent = "កំពុងទាញយកការវាយតម្លៃ...";
  reviewDialog.showModal();
  try {
    const data = await fetch(`/api/products/${id}/reviews`).then(r => r.json());
    list.replaceChildren();
    if (!data.reviews.length) { const empty=document.createElement("p"); empty.className="form-note"; empty.textContent="មិនទាន់មានការវាយតម្លៃទេ។"; list.append(empty); }
    data.reviews.forEach(review => {
      const item=document.createElement("article"); item.className="review-item";
      const title=document.createElement("strong"); title.textContent=`${"★".repeat(review.rating)}${"☆".repeat(5-review.rating)} · @${review.reviewer}`;
      const comment=document.createElement("p"); comment.textContent=review.comment || "គ្មានមតិយោបល់";
      const date=document.createElement("small"); date.textContent=review.created_at;
      item.append(title,comment,date); list.append(item);
    });
  } catch { list.textContent="មិនអាចទាញយកការវាយតម្លៃបានទេ។"; }
}
document.querySelector("#closeReviewDialog").addEventListener("click",()=>reviewDialog.close());
document.querySelector("#reviewForm").addEventListener("submit",async e=>{
  e.preventDefault();
  if (!chatToken) { showToast("សូមចូលគណនីដែលបានកុម្ម៉ង់ទំនិញនេះ។"); return; }
  const form=new FormData(e.currentTarget);
  try {
    const res=await fetch(`/api/products/${reviewProductId}/reviews`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${chatToken}`},body:JSON.stringify({rating:Number(form.get("rating")),comment:form.get("comment")})});
    const data=await res.json(); if(!res.ok) throw new Error(data.error || "មិនអាចផ្ញើការវាយតម្លៃបានទេ");
    showToast(data.message || "បានផ្ញើការវាយតម្លៃ។"); await load(); await openReview(reviewProductId);
  } catch(error) { showToast(error.message); }
});
async function loadMyOrders() {
  const panel=document.querySelector("#orderTrackingPanel"), list=document.querySelector("#myOrdersList");
  if (!chatToken || !chatUser) { panel.hidden=true; return; }
  panel.hidden=false; list.textContent="កំពុងទាញយកការកុម្ម៉ង់...";
  try {
    const data=await chatApi("/api/my/orders"); list.replaceChildren();
    if (!data.orders.length) { list.textContent="មិនទាន់មានការកុម្ម៉ង់ទេ។"; return; }
    data.orders.forEach(o=>{
      const item=document.createElement("article"); item.className="review-item";
      const title=document.createElement("strong"); title.textContent=`#${o.id} · ${o.title} · $${Number(o.total).toFixed(2)}`;
      const state=document.createElement("p"); state.textContent=`ការកុម្ម៉ង់៖ ${o.status} · ទូទាត់៖ ${o.payment_status} · អ្នកលក់៖ @${o.seller_name}`;
      item.append(title,state);
      if (o.seller_user_id===chatUser.id && o.status==="pending") { const b=document.createElement("button"); b.type="button"; b.textContent="សម្គាល់ថាបានផ្ញើ"; b.addEventListener("click",()=>changeOrderStatus(o.id,"shipped")); item.append(b); }
      if (o.buyer_user_id===chatUser.id && o.status==="shipped") { const b=document.createElement("button"); b.type="button"; b.textContent="ខ្ញុំបានទទួលទំនិញ"; b.addEventListener("click",()=>changeOrderStatus(o.id,"delivered")); item.append(b); }
      if (o.buyer_user_id===chatUser.id && o.payment_status==="unpaid") { const b=document.createElement("button"); b.type="button"; b.textContent="បានផ្ញើប្រាក់ — ស្នើឱ្យ Admin ពិនិត្យ"; b.addEventListener("click",async()=>{try{const d=await chatApi(`/api/orders/${o.id}/payment-notice`,{method:"POST"});showToast(d.message);await loadMyOrders()}catch(e){showToast(e.message)}}); item.append(b); }
      list.append(item);
    });
  } catch(err) { list.textContent=err.message; }
}
async function changeOrderStatus(id,status) {
  try { const d=await chatApi(`/api/orders/${id}/status`,{method:"PATCH",body:JSON.stringify({status})}); showToast(d.message); await loadMyOrders(); await load(); }
  catch(err) { showToast(err.message); }
}
async function loadAdminPanel() {
  const panel=document.querySelector("#adminPanel");
  if (!chatUser || chatUser.role!=="admin" || !chatToken) { panel.hidden=true; return; }
  panel.hidden=false;
  const [pr,or,rr]=await Promise.allSettled([chatApi("/api/admin/products"),chatApi("/api/admin/orders"),chatApi("/api/admin/reports")]);
  const productsEl=document.querySelector("#adminProductsList"); productsEl.replaceChildren();
  if(pr.status==="fulfilled") pr.value.products.forEach(p=>{
    const row=document.createElement("article"); row.className="review-item";
    const label=document.createElement("strong"); label.textContent=`#${p.id} ${p.title} — @${p.seller_username||p.seller_name} · ${p.verification_status}`; row.append(label);
    [["verified","សម្គាល់ថាបានផ្ទៀងផ្ទាត់"],["rejected","បដិសេធ"],["pending","ដាក់រង់ចាំ"]].forEach(([status,text])=>{const b=document.createElement("button");b.type="button";b.textContent=text;b.addEventListener("click",async()=>{try{await chatApi(`/api/admin/products/${p.id}/verification`,{method:"PATCH",body:JSON.stringify({status})});showToast("បានកែស្ថានភាពទំនិញ។");await loadAdminPanel();await load();}catch(e){showToast(e.message)}});row.append(b)});productsEl.append(row);
  }); else productsEl.textContent=pr.reason.message;
  const ordersEl=document.querySelector("#adminOrdersList"); ordersEl.replaceChildren();
  if(or.status==="fulfilled") or.value.orders.forEach(o=>{const row=document.createElement("article");row.className="review-item";const t=document.createElement("strong");t.textContent=`#${o.id} ${o.title} · $${Number(o.total).toFixed(2)} · ${o.payment_status}`;row.append(t);[["awaiting_confirmation","រង់ចាំបញ្ជាក់"],["confirmed","បញ្ជាក់ថាបានបង់"],["refunded","សងប្រាក់រួច"],["unpaid","មិនទាន់បង់"]].forEach(([status,text])=>{const b=document.createElement("button");b.type="button";b.textContent=text;b.addEventListener("click",async()=>{try{const d=await chatApi(`/api/admin/orders/${o.id}/payment`,{method:"PATCH",body:JSON.stringify({status})});showToast(d.message);await loadAdminPanel();await loadMyOrders()}catch(e){showToast(e.message)}});row.append(b)});ordersEl.append(row)}); else ordersEl.textContent=or.reason.message;
  const reportsEl=document.querySelector("#adminReportsList"); reportsEl.replaceChildren();
  if(rr.status==="fulfilled") rr.value.reports.forEach(r=>{const row=document.createElement("article");row.className="review-item";const t=document.createElement("strong");t.textContent=`Report #${r.id} · ${r.title} · @${r.reporter} · ${r.reason} · ${r.status}`;const d=document.createElement("p");d.textContent=r.details||"គ្មានព័ត៌មានបន្ថែម";row.append(t,d);[["reviewing","កំពុងពិនិត្យ"],["resolved","ដោះស្រាយរួច"],["dismissed","បិទរបាយការណ៍"]].forEach(([status,text])=>{const b=document.createElement("button");b.type="button";b.textContent=text;b.addEventListener("click",async()=>{try{await chatApi(`/api/admin/reports/${r.id}`,{method:"PATCH",body:JSON.stringify({status})});showToast("បានកែស្ថានភាពរបាយការណ៍។");await loadAdminPanel()}catch(e){showToast(e.message)}});row.append(b)});reportsEl.append(row)}); else reportsEl.textContent=rr.reason.message;
}

document.querySelector("#year").textContent = new Date().getFullYear();
load();

// In-site seller help bot (rule-based demo; it does not access private seller data).
const sellerBotToggle = document.querySelector("#sellerBotToggle");
const sellerBotPanel = document.querySelector("#sellerBotPanel");
const sellerBotMessages = document.querySelector("#sellerBotMessages");
const sellerBotInput = document.querySelector("#sellerBotInput");

function addBotMessage(text, who = "bot") {
  const item = document.createElement("div");
  item.className = who === "user" ? "user-message" : "bot-message";
  item.textContent = text;
  sellerBotMessages.appendChild(item);
  sellerBotMessages.scrollTop = sellerBotMessages.scrollHeight;
}
function answerSellerQuestion(question) {
  const q = question.toLowerCase();
  if (q.includes("ជើងសារ") || q.includes("commission") || q.includes("កម្រៃ")) {
    const badge = document.querySelector("#commissionBadge");
    return `កម្រៃជើងសារបច្ចុប្បន្ន៖ ${badge ? badge.textContent.replace("កម្រៃជើងសារ ", "") : "តាមការកំណត់របស់វេបសាយ"}។ ឧទាហរណ៍ បើលក់បាន $100 និងជើងសារ 5% នោះជើងសារ $5។ កំណែសាកល្បងនេះគណនាចំនួនប៉ុណ្ណោះ មិនទាន់ទូទាត់ប្រាក់ពិតទេ។`;
  }
  if (q.includes("ដាក់ទំនិញ") || q.includes("បង្ហោះ") || q.includes("ផលិតផល") || q.includes("listing")) {
    return "ដើម្បីដាក់ទំនិញ ត្រូវបង្កើតគណនី ឬចូលគណនីជាមុននៅផ្នែក «ជជែកផ្ទាល់ជាមួយអ្នកលក់»។ បន្ទាប់មកទៅ «ដាក់លក់» ហើយបញ្ចូលឈ្មោះទំនិញ ការពិពណ៌នា តម្លៃ USD និងតំណរូបភាព HTTPS (បើមាន)។ ឈ្មោះគណនីនឹងបង្ហាញជាឈ្មោះអ្នកលក់។ សូមបង្ហោះតែព័ត៌មានត្រឹមត្រូវ។";
  }
  if (q.includes("កុម្ម៉ង់") || q.includes("order") || q.includes("ការលក់")) {
    return "អតិថិជនអាចចុច «កុម្ម៉ង់ទំនិញ» លើទំនិញមួយ រួចបំពេញឈ្មោះ និងព័ត៌មានទំនាក់ទំនង។ Server នឹងរក្សាទុកការកុម្ម៉ង់ និងគណនាកម្រៃជើងសារសាកល្បង។";
  }
  if (q.includes("គណនី") || q.includes("ចុះឈ្មោះ") || q.includes("account")) {
    return "បាទ/ចាស។ អ្នកលក់ត្រូវបង្កើតគណនី ឬចូលគណនីមុនដាក់ទំនិញ។ នៅផ្នែក «ជជែកផ្ទាល់ជាមួយអ្នកលក់» បញ្ចូលឈ្មោះគណនី 3–24 តួ និងពាក្យសម្ងាត់យ៉ាងតិច 10 តួ រួចចុច «បង្កើតគណនី»។ បន្ទាប់មកទៅផ្នែក «ដាក់លក់»។";
  }
  if (q.includes("គុណភាព") || q.includes("វាយតម្លៃ") || q.includes("review") || q.includes("rating")) {
    return "មើលពិន្ទុ និងមតិយោបល់នៅលើកាតទំនិញ ហើយសួរអ្នកលក់អំពីស្ថានភាពទំនិញ តម្លៃដឹកជញ្ជូន និងគោលការណ៍ប្ដូរ/សងប្រាក់។ អ្នកអាចវាយតម្លៃបានក្រោយកុម្ម៉ង់ដោយប្រើគណនីដដែល។ ការវាយតម្លៃជួយកាត់បន្ថយហានិភ័យ ប៉ុន្តែមិនធានាថាទំនិញមានគុណភាពទាំងស្រុងទេ។";
  }
  if (q.includes("telegram") || q.includes("តេឡេក្រាម")) {
    return "ដើម្បីទទួលការជូនដំណឹង ត្រូវកំណត់ TELEGRAM_BOT_TOKEN និង TELEGRAM_ADMIN_CHAT_ID ក្នុងឯកសារ .env។ កុំដាក់ Token ក្នុងកូដផ្នែក Frontend ឬផ្ញើ Token ជាសាធារណៈ។";
  }
  if (q.includes("ប្រាក់") || q.includes("ទូទាត់") || q.includes("បង់")) {
    return "កំណែនេះមិនទាន់ទទួលប្រាក់ពិត ឬទូទាត់ប្រាក់ទៅអ្នកលក់ទេ។ មុនបើកប្រើពិត ត្រូវភ្ជាប់អ្នកផ្តល់សេវាទូទាត់ដែលអាចទុកចិត្តបាន និងផ្ទៀងផ្ទាត់ស្ថានភាពទូទាត់នៅ Server។";
  }
  if (q.includes("ជំនួយ") || q.includes("help") || q.includes("សួស្តី")) {
    return "ខ្ញុំអាចជួយណែនាំអំពីការដាក់ទំនិញ ការកុម្ម៉ង់ កម្រៃជើងសារ និងការភ្ជាប់ Telegram។ សូមចុចប៊ូតុងជម្រើស ឬសរសេរសំណួររបស់អ្នក។";
  }
  return "សូមសាកសួរអំពី «ដាក់ទំនិញ», «បង្កើតគណនី», «ការកុម្ម៉ង់», «ការវាយតម្លៃគុណភាព», «កម្រៃជើងសារ» ឬ «Telegram»។ Bot នេះជួយណែនាំជំហានប្រើវេបសាយ ប៉ុន្តែមិនអាចធានាគុណភាពទំនិញ ឬផ្ទៀងផ្ទាត់ការទូទាត់ប្រាក់ពិតបានទេ។";
}
function sendSellerBotQuestion(question) {
  const clean = question.trim();
  if (!clean) return;
  addBotMessage(clean, "user");
  addBotMessage(answerSellerQuestion(clean));
}
sellerBotToggle?.addEventListener("click", () => {
  const opening = sellerBotPanel.hidden;
  sellerBotPanel.hidden = !opening;
  sellerBotToggle.setAttribute("aria-expanded", String(opening));
  if (opening) sellerBotInput.focus();
});
document.querySelector("#sellerBotClose")?.addEventListener("click", () => {
  sellerBotPanel.hidden = true;
  sellerBotToggle.setAttribute("aria-expanded", "false");
});
document.querySelector("#sellerBotForm")?.addEventListener("submit", event => {
  event.preventDefault();
  sendSellerBotQuestion(sellerBotInput.value);
  sellerBotInput.value = "";
});
document.querySelectorAll("[data-bot-question]").forEach(button => {
  button.addEventListener("click", () => sendSellerBotQuestion(button.dataset.botQuestion));
});

// Authenticated private chat with private image uploads (QR/payment images).
const chatAuthForm = document.querySelector("#chatAuthForm");
const chatAuthPanel = document.querySelector("#chatAuthPanel");
const chatWorkspace = document.querySelector("#chatWorkspace");
const chatThreadsEl = document.querySelector("#chatThreads");
const chatMessagesEl = document.querySelector("#chatMessages");
const chatRoomTitle = document.querySelector("#chatRoomTitle");
const chatMessageForm = document.querySelector("#chatMessageForm");
const chatImageInput = document.querySelector("#chatImageInput");
const chatImageName = document.querySelector("#chatImageName");
const chatImageDialog = document.querySelector("#chatImageDialog");
let chatToken = sessionStorage.getItem("sh_chat_token") || "";
let chatUser = null;
let activeChatId = null;
let activeOtherUsername = "";
let chatImageObjectUrls = [];

async function chatApi(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (chatToken) headers.set("Authorization", `Bearer ${chatToken}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {...options, headers});
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "មានបញ្ហាក្នុងការតភ្ជាប់។");
  return data;
}
function chatSetLoggedOut() {
  chatToken = ""; chatUser = null; activeChatId = null; activeOtherUsername = "";
  sessionStorage.removeItem("sh_chat_token");
  chatWorkspace.hidden = true; chatAuthPanel.hidden = false;
  updateSellerGate();
  document.querySelector("#orderTrackingPanel").hidden=true; document.querySelector("#adminPanel").hidden=true;
  chatMessagesEl.replaceChildren(); chatThreadsEl.replaceChildren();
  chatRoomTitle.textContent = "ជ្រើសរើសបន្ទប់ជជែក";
}
async function chatStartSession(token) {
  chatToken = token; sessionStorage.setItem("sh_chat_token", token);
  try {
    const data = await chatApi("/api/auth/me"); chatUser = data.user;
    chatAuthPanel.hidden = true; chatWorkspace.hidden = false;
    updateSellerGate();
    document.querySelector("#chatLoggedInAs").textContent = `បានចូលជា @${chatUser.username}`;
    await chatLoadThreads();
    await loadMyOrders();
    await loadAdminPanel();
  } catch (error) { chatSetLoggedOut(); showToast(error.message); }
}
chatAuthForm?.addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(chatAuthForm);
  try {
    const data = await chatApi("/api/auth/login", {method:"POST", body:JSON.stringify({username:form.get("username"),password:form.get("password")})});
    await chatStartSession(data.token);
  } catch (error) { showToast(error.message); }
});
document.querySelector("#chatRegisterBtn")?.addEventListener("click", async () => {
  const form = new FormData(chatAuthForm);
  try {
    const data = await chatApi("/api/auth/register", {method:"POST", body:JSON.stringify({username:form.get("username"),password:form.get("password")})});
    await chatStartSession(data.token); showToast("បានបង្កើតគណនីដោយជោគជ័យ។");
  } catch (error) { showToast(error.message); }
});
document.querySelector("#chatLogoutBtn")?.addEventListener("click", async () => {
  try { if (chatToken) await chatApi("/api/auth/logout", {method:"POST"}); } catch (_) {}
  chatSetLoggedOut();
});
async function chatLoadThreads(selectId = activeChatId) {
  const data = await chatApi("/api/chats");
  chatThreadsEl.replaceChildren();
  if (!data.chats.length) {
    const empty = document.createElement("p"); empty.className = "form-note"; empty.style.padding = "12px"; empty.textContent = "មិនទាន់មានការជជែកទេ។ ចាប់ផ្ដើមដោយបញ្ចូលឈ្មោះគណនីខាងលើ។"; chatThreadsEl.append(empty);
    return;
  }
  data.chats.forEach(chat => {
    const button = document.createElement("button"); button.type = "button"; button.className = "chat-thread-button" + (chat.id === selectId ? " active" : "");
    const name = document.createElement("strong"); name.textContent = `@${chat.other_username}`;
    const preview = document.createElement("small"); preview.textContent = chat.last_message || (chat.last_image ? "🖼️ រូបភាព" : "ចាប់ផ្ដើមជជែក");
    button.append(name,preview); button.addEventListener("click", () => chatOpenThread(chat.id, chat.other_username)); chatThreadsEl.append(button);
  });
  if (selectId && data.chats.some(c=>c.id===selectId)) {
    const chat = data.chats.find(c=>c.id===selectId); activeOtherUsername = chat.other_username; await chatOpenThread(chat.id,chat.other_username,false);
  } else if (!activeChatId) {
    activeChatId = null; chatMessagesEl.replaceChildren(); chatRoomTitle.textContent = "ជ្រើសរើសបន្ទប់ជជែក";
  }
}
document.querySelector("#newChatForm")?.addEventListener("submit", async event => {
  event.preventDefault(); const username = new FormData(event.currentTarget).get("username").trim();
  try { const data = await chatApi("/api/chats", {method:"POST",body:JSON.stringify({username})}); event.currentTarget.reset(); await chatLoadThreads(data.chat.id); await chatOpenThread(data.chat.id,data.chat.other_username); }
  catch (error) { showToast(error.message); }
});
async function chatOpenThread(id, username, reload = true) {
  activeChatId = Number(id); activeOtherUsername = username;
  chatRoomTitle.textContent = `ជជែកជាមួយ @${username}`;
  chatThreadsEl.querySelectorAll(".chat-thread-button").forEach(button => button.classList.toggle("active", button.textContent.includes(`@${username}`)));
  if (reload) await chatLoadThreads(id);
  await chatLoadMessages();
}
async function chatLoadMessages() {
  if (!activeChatId) return;
  const data = await chatApi(`/api/chats/${activeChatId}/messages`);
  chatImageObjectUrls.forEach(URL.revokeObjectURL); chatImageObjectUrls = [];
  chatMessagesEl.replaceChildren();
  for (const message of data.messages) {
    const bubble = document.createElement("div"); bubble.className = "chat-bubble" + (message.sender_id === chatUser?.id ? " mine" : "");
    if (message.message_text) { const text = document.createElement("div"); text.textContent = message.message_text; bubble.append(text); }
    if (message.imageUrl) {
      try {
        const response = await fetch(message.imageUrl,{headers:{Authorization:`Bearer ${chatToken}`}});
        if (response.ok) {
          const url=URL.createObjectURL(await response.blob()); chatImageObjectUrls.push(url);
          const img=document.createElement("img"); img.src=url; img.alt="រូបភាពក្នុងសារជជែក"; img.loading="lazy";
          img.addEventListener("click",()=>{document.querySelector("#chatZoomImage").src=url;chatImageDialog.showModal();}); bubble.append(img);
        }
      } catch (_) {}
    }
    const time=document.createElement("time"); time.textContent=new Date(message.created_at.replace(" ","T")+"Z").toLocaleString(); bubble.append(time); chatMessagesEl.append(bubble);
  }
  chatMessagesEl.scrollTop=chatMessagesEl.scrollHeight;
}
chatImageInput?.addEventListener("change", () => { chatImageName.textContent = chatImageInput.files?.[0]?.name || ""; });
chatMessageForm?.addEventListener("submit", async event => {
  event.preventDefault(); if (!activeChatId) return showToast("សូមជ្រើសរើស ឬចាប់ផ្ដើមបន្ទប់ជជែកជាមុនសិន។");
  const text=String(new FormData(chatMessageForm).get("text") || "").trim(); const file=chatImageInput.files?.[0];
  if (!text && !file) return showToast("សូមសរសេរសារ ឬជ្រើសរើសរូបភាព។");
  try {
    if (file) {
      if (file.size > 5*1024*1024) throw new Error("រូបភាពធំពេក។ អតិបរមា 5MB។");
      if (!["image/jpeg","image/png","image/webp","image/gif"].includes(file.type)) throw new Error("អនុញ្ញាតតែ JPG, PNG, WEBP ឬ GIF ប៉ុណ្ណោះ។");
      const body=new FormData(); body.append("image",file); body.append("text",text);
      await chatApi(`/api/chats/${activeChatId}/images`,{method:"POST",body});
    } else {
      await chatApi(`/api/chats/${activeChatId}/messages`,{method:"POST",body:JSON.stringify({text})});
    }
    chatMessageForm.querySelector("textarea").value=""; chatImageInput.value=""; chatImageName.textContent="";
    await chatLoadMessages(); await chatLoadThreads(activeChatId);
  } catch(error) { showToast(error.message); }
});
document.querySelector("#closeChatImage")?.addEventListener("click",()=>chatImageDialog.close());
chatImageDialog?.addEventListener("click",event=>{if(event.target===chatImageDialog)chatImageDialog.close();});
if (chatToken) chatStartSession(chatToken);
