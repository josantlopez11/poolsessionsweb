require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");

const app = express();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const frontendPath = path.resolve(__dirname, "frontend");

app.use(express.static(frontendPath));

app.get("/confirmacion", (req, res) => {
  res.sendFile(path.join(frontendPath, "confirmacion.html"));
});

// ─────────────────────────────────────
// 🚨 WEBHOOK PRIMERO (ANTES DE JSON)
// ─────────────────────────────────────

app.post("/webhook-stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log("❌ Error firma webhook:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.order_id;

    try {
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          stripe_session_id: session.id,
        })
        .eq("id", orderId);

      console.log("✅ Orden marcada como PAID:", orderId);
    } catch (err) {
      console.error("❌ Error actualizando orden:", err);
    }
  }

  res.status(200).send("ok");
});

// 👉 GET para evitar 405 en navegador/test
app.get("/webhook-stripe", (req, res) => {
  res.send("Webhook activo");
});


// ─────────────────────────────────────
// MIDDLEWARES NORMALES
// ─────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(frontendPath));


// ─────────────────────────────────────
// HOME
// ─────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});


// ─────────────────────────────────────
// CREAR CHECKOUT
// ─────────────────────────────────────

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
        payment_status: "pending", // modo test
      })
      .select()
      .single();

    const tickets = Array.from({ length: ticketQuantity }).map((_, i) => ({
      order_id: order.id,
      event_id: event.id,
      ticket_code: makeTicketCode(i),
      qr_token: makeQrToken(),
      status: "valid",
    }));

    await supabase.from("tickets").insert(tickets);

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
            product_data: {
              name: event.name,
              description: event.description,
            },
          },
        },
      ],
      success_url: `${process.env.APP_URL}/confirmacion?order=${order.id}`,
      cancel_url: `${process.env.APP_URL}/error.html`,
    });

    await supabase
      .from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", order.id);

    console.log("🔥 SUCCESS URL:", `${process.env.APP_URL}/confirmacion?order=${order.id}`);

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────
// CONFIRMACION PAGE
// ─────────────────────────────────────

app.get("/confirmacion", (req, res) => {
  console.log("🔥 entrando a confirmacion");
  res.sendFile(path.resolve(frontendPath, "confirmacion.html"));
});


// ─────────────────────────────────────
// DATA PARA FRONTEND
// ─────────────────────────────────────

app.get("/confirmacion-data", async (req, res) => {
  const { order } = req.query;

  try {
    const { data: tickets } = await supabase
      .from("tickets")
      .select("*, event:event_id(*)")
      .eq("order_id", order);

    const result = await Promise.all(
      tickets.map(async (t) => {
        const qr = await QRCode.toDataURL(
          `${process.env.APP_URL}/validate?token=${t.qr_token}`
        );

        return {
          ticket_code: t.ticket_code,
          event_name: t.event.name,
          event_date: t.event.date,
          event_time: t.event.time,
          venue: t.event.venue,
          buyer_name: t.buyer_name,
          buyer_email: t.buyer_email,
          qr,
        };
      })
    );

    res.json({ tickets: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error generando tickets" });
  }
});


// ─────────────────────────────────────
// VALIDACION QR
// ─────────────────────────────────────

app.get("/validate", async (req, res) => {
  const { token } = req.query;

  const { data: ticket } = await supabase
    .from("tickets")
    .select("*")
    .eq("qr_token", token)
    .single();

  if (!ticket) return res.send("❌ INVÁLIDO");
  if (ticket.status === "used") return res.send("⚠️ YA USADO");

  res.send("✅ VÁLIDO");
});


// ─────────────────────────────────────
// CATCH ALL
// ─────────────────────────────────────

app.get(/^\/(?!confirmacion).*$/, (req, res) => {
  res.sendFile(path.resolve(frontendPath, "index.html"));
});


// ─────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 SERVER RUNNING ON", PORT));


// ─────────────────────────────────────
// HELPERS
// ─────────────────────────────────────

function makeTicketCode(i) {
  return `PS-T-${Date.now()}-${i}-${crypto.randomBytes(2).toString("hex")}`;
}

function makeQrToken() {
  return crypto.randomUUID();
}