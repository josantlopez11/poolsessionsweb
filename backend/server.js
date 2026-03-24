require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");

const app = express();

// CLIENTES
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// PATH FRONTEND
const frontendPath = path.resolve(__dirname, "../frontend");
console.log("📁 FRONTEND PATH:", frontendPath);

// MIDDLEWARES
app.use(cors());
app.use(express.json({ strict: true, limit: "1mb" }));

// SERVIR FRONTEND
app.use(express.static(frontendPath));

// HOME
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "boletos.html")));

// CHECKOUT
app.post("/create-checkout-session", async (req, res) => {
  const body = req.body || {};
  const eventSlug = String(body.eventSlug || "").trim();
  const buyerName = String(body.buyerName || "").trim();
  const buyerEmail = String(body.buyerEmail || "").trim();
  const buyerPhone = String(body.buyerPhone || "0000000000").trim();
  const ticketQuantity = Number(body.ticketQuantity);

  if (!eventSlug || !buyerName || !buyerEmail || !ticketQuantity) {
    console.log("❌ Datos incompletos:", { eventSlug, buyerName, buyerEmail, buyerPhone, ticketQuantity });
    return res.status(400).json({ error: "Datos incompletos" });
  }

  // Buscar evento
  const { data: event } = await supabase
    .from("events")
    .select("*")
    .eq("slug", eventSlug)
    .single();

  if (!event) return res.status(500).json({ error: "Evento no encontrado" });

  // Crear orden
  const { data: order } = await supabase
    .from("orders")
    .insert({
      event_id: event.id,
      order_code: `PS-ORD-${Date.now()}`,
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      buyer_phone: buyerPhone,
      ticket_quantity: ticketQuantity,
      unit_price: event.unit_price,
      total_amount: ticketQuantity * event.unit_price,
      payment_status: "pending",
    })
    .select()
    .single();

  // Crear sesión Stripe
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: buyerEmail,
    metadata: { order_id: order.id },
    line_items: [
      {
        quantity: ticketQuantity,
        price_data: {
          currency: "mxn",
          unit_amount: event.unit_price * 100,
          product_data: { name: event.name, description: event.description },
        },
      },
    ],
    success_url: `${process.env.APP_URL}/confirmacion?order=${order.id}`,
    cancel_url: `${process.env.APP_URL}/error.html`,
  });

  await supabase.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

  res.json({ checkoutUrl: session.url });
});

// CONFIRMACION
app.get("/confirmacion", async (req, res) => {
  const { order } = req.query;
  const { data: tickets } = await supabase.from("tickets").select("*").eq("order_id", order);
  if (!tickets || tickets.length === 0) return res.send("<h2>Generando boletos...</h2>");

  const ticketHtml = await Promise.all(
    tickets.map(async (t) => {
      const qr = await QRCode.toDataURL(`${process.env.APP_URL}/validate?token=${t.qr_token}`);
      return `<div style="text-align:center;margin-bottom:40px;">
                <img src="/assets/pool-logo.jpg" style="width:80px"/>
                <h3>${t.ticket_code}</h3>
                <img src="${qr}" width="200"/>
              </div>`;
    })
  );

  res.send("<h1>🎟 TUS BOLETOS</h1>" + ticketHtml.join(""));
});

// VALIDAR
app.get("/validate", async (req, res) => {
  const { token } = req.query;
  const { data: ticket } = await supabase.from("tickets").select("*").eq("qr_token", token).single();
  if (!ticket) return res.send("❌ INVÁLIDO");
  if (ticket.status === "used") return res.send("⚠️ YA USADO");
  res.send("✅ VÁLIDO");
});

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 SERVER RUNNING ON", PORT));

// HELPERS
function makeTicketCode(i) { return `PS-T-${Date.now()}-${i}-${crypto.randomBytes(2).toString("hex")}`; }
function makeQrToken() { return crypto.randomUUID(); }