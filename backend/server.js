require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");

const app = express();

// 🔌 CLIENTES (al inicio)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 🔥 PATH ABSOLUTO FRONTEND
const frontendPath = path.resolve(__dirname, "../frontend");
console.log("📁 FRONTEND PATH:", frontendPath);

// 🔥 WEBHOOK STRIPE
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("❌ Webhook error:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata.order_id;

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .single();

      if (!order) return res.json({ received: true });
      if (order.payment_status === "paid") return res.json({ received: true });

      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          stripe_payment_intent: session.payment_intent,
        })
        .eq("id", order.id);

      const tickets = Array.from({ length: order.ticket_quantity }).map((_, i) => ({
        order_id: order.id,
        event_id: order.event_id,
        ticket_code: makeTicketCode(i),
        qr_token: makeQrToken(),
        status: "valid",
      }));

      await supabase.from("tickets").insert(tickets);

      console.log("🎟 Tickets generados");
    }

    res.json({ received: true });
  }
);

// 🔧 MIDDLEWARES
app.use(cors());
app.use(express.json());

// 🔥 SERVIR FRONTEND
app.use(express.static(frontendPath));

// 🟢 HOME
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// 🎟 CHECKOUT
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { eventSlug, buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;

    if (!eventSlug || !buyerName || !buyerEmail || !ticketQuantity) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const { data: event } = await supabase
      .from("events")
      .select("*")
      .eq("slug", eventSlug)
      .single();

    if (!event) return res.status(500).json({ error: "Evento no encontrado" });

    const quantity = Number(ticketQuantity);
    if (quantity <= 0) return res.status(400).json({ error: "Cantidad inválida" });

    const { data: order } = await supabase
      .from("orders")
      .insert({
        event_id: event.id,
        order_code: `PS-ORD-${Date.now()}`,
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_phone: buyerPhone,
        ticket_quantity: quantity,
        unit_price: event.unit_price,
        total_amount: quantity * event.unit_price,
        payment_status: "pending",
      })
      .select()
      .single();

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

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

// 🎉 CONFIRMACIÓN
app.get("/confirmacion", async (req, res) => {
  try {
    const { order } = req.query;

    const { data: tickets } = await supabase
      .from("tickets")
      .select("*")
      .eq("order_id", order);

    if (!tickets || tickets.length === 0) {
      return res.send("<h2>Generando boletos... recarga en unos segundos</h2>");
    }

    const ticketHtml = await Promise.all(
      tickets.map(async (t) => {
        const qr = await QRCode.toDataURL(
          `${process.env.APP_URL}/validate?token=${t.qr_token}`
        );
        return `
          <div style="margin-bottom:40px; text-align:center;">
            <img src="/assets/pool-logo.jpg" style="width:80px"/>
            <h3>${t.ticket_code}</h3>
            <img src="${qr}" width="200"/>
          </div>
        `;
      })
    );

    res.send(`<h1>🎟 TUS BOLETOS</h1>` + ticketHtml.join(""));
  } catch (err) {
    console.log(err);
    res.status(500).send("<h2>Error generando boletos</h2>");
  }
});

// 🎫 VALIDAR
app.get("/validate", async (req, res) => {
  try {
    const { token } = req.query;

    const { data: ticket } = await supabase
      .from("tickets")
      .select("*")
      .eq("qr_token", token)
      .single();

    if (!ticket) return res.send("❌ INVÁLIDO");
    if (ticket.status === "used") return res.send("⚠️ YA USADO");

    res.send("✅ VÁLIDO");
  } catch (err) {
    console.log(err);
    res.status(500).send("❌ ERROR");
  }
});

// 🔥 FALLBACK EXPRESS 5 COMPATIBLE PARA RAILWAY
app.all("*", (req, res) => {
  res.sendFile(path.resolve(frontendPath, "index.html"), (err) => {
    if (err) {
      console.error("❌ Error enviando index.html:", err);
      res.status(500).send("Error cargando la página");
    }
  });
});

// 🚀 START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 SERVER RUNNING ON", PORT);
});

// 🔑 HELPERS
function makeTicketCode(i) {
  return `PS-T-${Date.now()}-${i}-${crypto.randomBytes(2).toString("hex")}`;
}

function makeQrToken() {
  return crypto.randomUUID();
}