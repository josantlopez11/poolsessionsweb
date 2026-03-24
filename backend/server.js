require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");

const app = express();

// 🔌 CLIENTES
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 🔥 PATH ABSOLUTO FRONTEND
const frontendPath = path.resolve(__dirname, "../frontend");
console.log("📁 FRONTEND PATH:", frontendPath);

// 🔧 MIDDLEWARES
app.use(cors());
app.use(express.json());

// 🔥 SERVIR FRONTEND
app.use(express.static(frontendPath));
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "index.html")));

// 🎟 CREATE CHECKOUT SESSION
app.post("/create-checkout-session", async (req, res) => {
  const { eventSlug, buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;

  // Validación estricta
  if (!eventSlug || !buyerName || !buyerEmail || !ticketQuantity) {
    console.log("❌ Datos incompletos detectados:", { eventSlug, buyerName, buyerEmail, buyerPhone, ticketQuantity });
    return res.status(400).json({ error: "Datos incompletos" });
  }

  const quantity = Number(ticketQuantity);
  if (isNaN(quantity) || quantity <= 0) return res.status(400).json({ error: "Cantidad inválida" });

  try {
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
        buyer_phone: buyerPhone || "0000000000",
        ticket_quantity: quantity,
        unit_price: event.unit_price,
        total_amount: quantity * event.unit_price,
        payment_status: "pending",
      })
      .select()
      .single();

    // Crear sesión Stripe
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      metadata: {
        order_id: order.id,
        ticket_quantity: String(quantity),
        buyer_name: buyerName,
      },
      line_items: [
        {
          quantity,
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

    // Guardar session_id
    await supabase.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

    console.log("✅ Sesión de checkout creada:", session.id);
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("❌ Error en /create-checkout-session:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔑 HELPERS
function makeTicketCode(i) { return `PS-T-${Date.now()}-${i}-${crypto.randomBytes(2).toString("hex")}`; }
function makeQrToken() { return crypto.randomUUID(); }

// 🚀 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 SERVER RUNNING ON", PORT));