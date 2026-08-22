import { supabase } from "./client.js";
async function guard() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    location.href = "./index.html";
    return false;
  }
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (data?.role !== "admin") {
    alert("Admin access required.");
    location.href = "./index.html";
    return false;
  }
  return true;
}
async function load() {
  if (!(await guard())) return;
  const [
    { data: orders },
    { data: tickets },
    { data: subs },
    { data: products },
    { data: cms },
  ] = await Promise.all([
    supabase
      .from("orders")
      .select("amount,status,created_at,customer_email,products(title)")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("tickets")
      .select("id,subject,category,status,created_at,email")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("subscribers").select("id"),
    supabase
      .from("products")
      .select("id,title,price,currency,is_published")
      .order("created_at", { ascending: false }),
    supabase.from("site_settings").select("*").limit(1).maybeSingle(),
  ]);
  document.querySelector("#m-orders").textContent = orders?.length ?? 0;
  document.querySelector("#m-revenue").textContent = `$${(orders || [])
    .filter((o) => o.status === "paid")
    .reduce((s, o) => s + Number(o.amount), 0)
    .toFixed(2)}`;
  document.querySelector("#m-tickets").textContent = (tickets || []).filter(
    (t) => t.status !== "closed",
  ).length;
  document.querySelector("#m-subs").textContent = subs?.length ?? 0;
  document.querySelector("#products-table").innerHTML = table(
    products || [],
    ["Title", "Price", "Published"],
    (p) =>
      `<td>${esc(p.title)}</td><td>${p.currency} ${Number(p.price).toFixed(2)}</td><td>${p.is_published ? "Yes" : "No"}</td>`,
  );
  document.querySelector("#orders-table").innerHTML = table(
    orders || [],
    ["Customer", "Book", "Amount", "Status"],
    (o) =>
      `<td>${esc(o.customer_email || "")}</td><td>${esc(o.products?.title || "")}</td><td>${o.currency || "USD"} ${Number(o.amount).toFixed(2)}</td><td>${esc(o.status)}</td>`,
  );
  document.querySelector("#tickets-table").innerHTML = table(
    tickets || [],
    ["Email", "Subject", "Category", "Status"],
    (t) =>
      `<td>${esc(t.email)}</td><td>${esc(t.subject)}</td><td>${esc(t.category)}</td><td>${esc(t.status)}</td>`,
  );
  if (cms)
    Object.entries({
      site_title: "site_title",
      support_email: "support_email",
      announcement: "announcement",
    }).forEach(
      ([k, n]) =>
        (document.querySelector(`[name="${n}"]`).value = cms[k] || ""),
    );
}
function table(rows, heads, render) {
  if (!rows.length)
    return '<p class="text-sm text-slate-500">No records yet.</p>';
  return `<div class="overflow-x-auto"><table class="min-w-full text-left text-sm"><thead><tr>${heads.map((h) => `<th class="px-3 py-3 font-black text-slate-500">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr class="border-t border-stone-200/60">${render(r)}</tr>`).join("")}</tbody></table></div>`;
}
function esc(v) {
  return String(v ?? "").replace(
    /[&<>\"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '\"': "&quot;",
        "'": "&#039;",
      })[m],
  );
}
document.querySelector("#admin-signout").addEventListener("click", async () => {
  await supabase.auth.signOut();
  location.href = "./index.html";
});
document.querySelector("#cms-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = Object.fromEntries(new FormData(e.currentTarget).entries());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("site_settings")
    .upsert({ id: 1, ...p, updated_by: user.id });
  alert(error ? error.message : "CMS saved.");
});
load();
