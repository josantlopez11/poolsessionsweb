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

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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

  // ─── EVENTO: PAGO COMPLETADO ─────────────────────────────
  if (event.type === "checkout.session.completed") {

    console.log("🔥 WEBHOOK RECIBIDO");

    const session = event.data.object;
    const orderId = session.metadata?.order_id;

    console.log("📦 ORDER ID:", orderId);

    if (!orderId) {
      console.log("❌ No hay order_id en metadata");
      return res.status(200).send("ok");
    }

    try {
      // 1. actualizar orden
      const { error: updateError } = await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          stripe_session_id: session.id,
        })
        .eq("id", orderId);

      if (updateError) {
        console.error("❌ Error actualizando orden:", updateError);
        return res.status(200).send("ok");
      }

      console.log("✅ Orden marcada como PAID");

      // 2. obtener orden
      const { data: orderData, error: orderError } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .single();

      if (orderError || !orderData) {
        console.error("❌ Error obteniendo orden:", orderError);
        return res.status(200).send("ok");
      }

      console.log("📊 ORDER DATA:", orderData);

      // 3. validar email
      if (!orderData.buyer_email) {
        console.log("❌ No hay email del comprador");
        return res.status(200).send("ok");
      }

      console.log("📨 Enviando email a:", orderData.buyer_email);

      // 4. enviar email
      await sendTicketsEmail(
        orderId,
        orderData.buyer_email,
        orderData.buyer_name || "INVITADO"
      );

      console.log("✅ EMAIL ENVIADO");

    } catch (err) {
      console.error("❌ ERROR GENERAL EN WEBHOOK:", err);
    }
  }

  // ✅ ÚNICA RESPUESTA FINAL (IMPORTANTE)
  return res.status(200).send("ok");
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

    if (!event) {
      console.error("❌ EVENTO NO ENCONTRADO");
      return res.status(500).json({ error: "Evento no encontrado" });
    }

    // 🔥 VALIDACIÓN PRO DE PRECIO
    const price = Number(event.unit_price);

    console.log("UNIT PRICE RAW:", event.unit_price);
    console.log("UNIT PRICE TYPE:", typeof event.unit_price);

    if (!price || isNaN(price)) {
      console.error("❌ PRECIO INVÁLIDO:", event.unit_price);
      return res.status(500).json({ error: "Precio inválido" });
    }

    const { data: order } = await supabase
      .from("orders")
      .insert({
        event_id: event.id,
        order_code: `PS-ORD-${Date.now()}`,
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_phone: buyerPhone || "0000000000",
        ticket_quantity: ticketQuantity,
        unit_price: price,
        total_amount: ticketQuantity * price,
        payment_status: "pending",
      })
      .select()
      .single();

    if (!order) {
      console.error("❌ ERROR CREANDO ORDER");
      return res.status(500).json({ error: "Error creando orden" });
    }

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
            unit_amount: price * 100, // 🔥 FIX
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
    console.error("❌ ERROR GENERAL:", err);
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
// CONFIRMACIÓN DATA PARA FRONTEND
// ─────────────────────────────────────

app.get("/confirmacion-data", async (req, res) => {
  const { order } = req.query;

  if (!order) {
    return res.status(400).json({ error: "Falta order id" });
  }

  try {
    console.log("🟡 ORDER:", order);

    // 🔹 ORDEN
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("*")
      .eq("id", order)
      .single();

    if (orderError || !orderData) {
      console.log("❌ ORDER ERROR:", orderError);
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    // 🔹 TICKETS
    const { data: tickets, error: ticketsError } = await supabase
      .from("tickets")
      .select("*")
      .eq("order_id", order);

    if (ticketsError) {
      console.log("❌ TICKETS ERROR:", ticketsError);
      return res.status(500).json({ error: "Error tickets" });
    }

    if (!tickets || tickets.length === 0) {
      return res.json({
        buyer_name: orderData.buyer_name || "INVITADO",
        tickets: [],
      });
    }

    // 🔹 EVENTO
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("*")
      .eq("id", tickets[0].event_id)
      .single();

    if (eventError) {
      console.log("❌ EVENT ERROR:", eventError);
    }

    const result = await Promise.all(
      tickets.map(async (t) => {
        const qr = await QRCode.toDataURL(
          `${process.env.APP_URL}/validate?token=${t.qr_token}`
        );

        return {
          ticket_code: t.ticket_code,
          event_name: event?.name || "POOL SESSIONS",
          event_description: event?.description || "",
          event_date: event?.event_date || "",
          event_time: event?.time || "",
          venue: event?.venue || "",
          qr,
        };
      })
    );

    res.json({
      buyer_name: orderData.buyer_name || "INVITADO",
      tickets: result,
    });

  } catch (err) {
    console.error("❌ ERROR GENERAL:", err);
    res.status(500).json({ error: "Error cargando confirmación" });
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


// RESEND DE CORREO CON QR

async function sendTicketsEmail(orderId, buyerEmail, buyerName) {
  try {
    const { data: tickets } = await supabase
      .from("tickets")
      .select("*, event:event_id(*)")
      .eq("order_id", orderId);

    const ticketHTML = await Promise.all(
      tickets.map(async (t) => {
        const qr = await QRCode.toDataURL(`${process.env.APP_URL}/validate?token=${t.qr_token}`);

        return `
          <div style="margin-bottom:30px;">
            <h3>${t.event.name}</h3>
            <p>${t.event.date} ${t.event.time}</p>
            <p>${t.event.venue}</p>
            <img src="${qr}" width="150"/>
            <p>${t.ticket_code}</p>
          </div>
        `;
      })
    );

    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: buyerEmail,
      subject: '🎟️ Tus boletos - POOL SESSIONS',
      html: `
        <h2>¡Gracias ${buyerName} por tu compra!</h2>
        <p>Aquí están tus boletos:</p>
        ${ticketHTML.join("")}
      `
    });

    console.log("📩 Email enviado a", buyerEmail);

  } catch (err) {
    console.error("Error enviando email:", err);
  }
}