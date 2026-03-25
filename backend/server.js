require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");
const bodyParser = require('body-parser');

const app = express();

// ─── SUPABASE ─────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── STRIPE ───────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── FRONTEND PATH ────────────────────
const frontendPath = path.resolve(__dirname, "../frontend");
console.log("📁 FRONTEND PATH:", frontendPath);

// ─── MIDDLEWARES ─────────────────────
// Cors para todas las rutas
app.use(cors());

// JSON para endpoints normales (NO PARA WEBHOOK)
app.use(express.json());
app.use(express.static(frontendPath));

// ─── RUTAS ───────────────────────────

// Home
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// Crear checkout
app.post("/create-checkout-session", async (req, res) => {
  try {
    let { buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;
    const eventSlug = "pool-sessions-3";

    ticketQuantity = Number(ticketQuantity);

    if (!buyerName || !buyerEmail || !ticketQuantity) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const { data: event } = await supabase
      .from("events")
      .select("*")
      .eq("slug", eventSlug)
      .single();

    if (!event) return res.status(500).json({ error: "Evento no encontrado" });
    if (ticketQuantity <= 0) return res.status(400).json({ error: "Cantidad inválida" });

    // Crear orden
    const { data: order } = await supabase
      .from("orders")
      .insert({
        event_id: event.id,
        order_code: `PS-ORD-${Date.now()}`,
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_phone: buyerPhone || "0000000000",
        ticket_quantity: ticketQuantity,
        unit_price: event.unit_price,
        total_amount: ticketQuantity * event.unit_price,
        payment_status: "pending", // simulamos pago en pruebas
      })
      .select()
      .single();

    // Crear tickets
    const tickets = Array.from({ length: ticketQuantity }).map((_, i) => ({
      order_id: order.id,
      event_id: event.id,
      ticket_code: makeTicketCode(i),
      qr_token: makeQrToken(),
      status: "valid",
      buyer_name: buyerName,
      buyer_email: buyerEmail,
    }));

    await supabase.from("tickets").insert(tickets);

    // Crear sesión Stripe
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      metadata: {
        order_id: order.id,
        ticket_quantity: String(ticketQuantity),
        buyer_name: buyerName,
      },
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Servir confirmación HTML
app.get("/confirmacion", (req, res) => {
  res.sendFile(path.resolve(frontendPath, "confirmacion.html"), (err) => {
    if (err) res.status(500).send("Error cargando confirmacion.html");
  });
});

// Datos para confirmación frontend
app.get("/confirmacion-data", async (req, res) => {
  const { order } = req.query;
  if (!order) return res.status(400).json({ error: "Falta order id" });

  try {
    const { data: tickets } = await supabase
      .from("tickets")
      .select("*, event:event_id(*)")
      .eq("order_id", order);

    const result = await Promise.all(
      tickets.map(async (t) => {
        // Generamos QR aunque sea pending para pruebas
        const qr = await QRCode.toDataURL(`${process.env.APP_URL}/validate?token=${t.qr_token}`);
        return {
          ticket_code: t.ticket_code,
          event_name: t.event.name,
          event_description: t.event.description,
          event_date: t.event.date,
          event_time: t.event.time,
          venue: t.event.venue,
          buyer_name: t.buyer_name,
          buyer_email: t.buyer_email,
          qr,
        };
      })
    );

    res.json({ tickets: result, status: "Pago exitoso" }); // Siempre muestra pago exitoso
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error generando tickets" });
  }
});

// Validar ticket
app.get("/validate", async (req, res) => {
  const { token } = req.query;
  try {
    const { data: ticket } = await supabase.from("tickets").select("*").eq("qr_token", token).single();
    if (!ticket) return res.send("❌ INVÁLIDO");
    if (ticket.status === "used") return res.send("⚠️ YA USADO");
    res.send("✅ VÁLIDO");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ ERROR");
  }
});

// ─── WEBHOOK STRIPE ───────────────────
// Este endpoint requiere RAW body para la verificación de firma
app.post("/webhook-stripe", bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata.order_id;

    try {
      await supabase.from('orders').update({ payment_status: 'paid', stripe_session_id: session.id }).eq('id', orderId);
      console.log(`✅ Order ${orderId} marcado como PAID`);
    } catch (err) {
      console.error('Error actualizando la orden:', err);
    }
  }

  res.status(200).send('ok');
});

// Catch-all para otras rutas
app.get(/^\/(?!confirmacion).*$/, (req, res) => {
  res.sendFile(path.resolve(frontendPath, "index.html"), (err) => {
    if (err) res.status(500).send("Error cargando la página");
  });
});

// Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 SERVER RUNNING ON", PORT));

// ─── FUNCIONES AUXILIARES ───────────
function makeTicketCode(i) {
  return `PS-T-${Date.now()}-${i}-${crypto.randomBytes(2).toString("hex")}`;
}

function makeQrToken() {
  return crypto.randomUUID();
}