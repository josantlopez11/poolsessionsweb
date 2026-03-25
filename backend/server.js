require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");

const app = express();

// Supabase
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const frontendPath = path.resolve(__dirname, "../frontend");
console.log("📁 FRONTEND PATH:", frontendPath);

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(frontendPath));

// HOME
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// CREATE CHECKOUT SESSION
app.post("/create-checkout-session", async (req, res) => {
  try {
    let { buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;
    const eventSlug = "pool-sessions-3";

    ticketQuantity = Number(ticketQuantity);
    if (!buyerName || !buyerEmail || !ticketQuantity)
      return res.status(400).json({ error: "Datos incompletos" });

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
        payment_status: "pending",
      })
      .select()
      .single();

    // Generar tickets y QR (aunque pending)
    const tickets = await Promise.all(
      Array.from({ length: ticketQuantity }).map(async (_, i) => {
        const qr_token = makeQrToken();
        const qr = await QRCode.toDataURL(`${process.env.APP_URL}/validate?token=${qr_token}`);
        return {
          order_id: order.id,
          event_id: event.id,
          ticket_code: makeTicketCode(i),
          qr_token,
          qr,
          status: "valid",
        };
      })
    );

    await supabase.from("tickets").insert(tickets);

    // Crear sesión de Stripe
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

// CONFIRMACION
app.get("/confirmacion", (req, res) => {
  res.sendFile(path.resolve(frontendPath, "confirmacion.html"), (err) => {
    if (err) res.status(500).send("Error cargando confirmacion.html");
  });
});

// ENDPOINT PARA DATA DE CONFIRMACION (QR + info)
app.get("/confirmacion-data", async (req, res) => {
  const { order } = req.query;
  if (!order) return res.status(400).json({ error: "Falta order id" });

  try {
    const { data: tickets } = await supabase
      .from("tickets")
      .select("*, order:order_id(*), event:event_id(*)")
      .eq("order_id", order);

    if (!tickets || tickets.length === 0) return res.status(404).json({ error: "No hay tickets" });

    // Solo mostrar QR si pago es 'paid' (para pruebas siempre mostramos)
    const result = tickets.map((t) => ({
      ticket_code: t.ticket_code,
      buyer_name: t.order.buyer_name,
      buyer_email: t.order.buyer_email,
      event_name: t.event.name,
      event_description: t.event.description,
      event_date: t.event.date,
      event_time: t.event.time,
      venue: t.event.venue,
      qr: t.qr, // siempre generado aunque pending
      payment_status: t.order.payment_status,
    }));

    res.json({ tickets: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error generando tickets" });
  }
});

// WEBHOOK STRIPE
app.post("/webhook-stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️ Webhook signature failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.order_id;
    // marcar como pagado
    await supabase.from("orders").update({ payment_status: "paid" }).eq("id", orderId);
    console.log(`✅ Orden ${orderId} marcada como PAID`);
  }

  res.json({ received: true });
});

// VALIDACION DE TICKET
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

// CATCH ALL
app.get(/^\/(?!confirmacion).*$/, (req, res) => {
  res.sendFile(path.resolve(frontendPath, "index.html"), (err) => {
    if (err) res.status(500).send("Error cargando la página");
  });
});

// PUERTO
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 SERVER RUNNING ON", PORT));

// FUNCIONES AUX
function makeTicketCode(i) {
  return `PS-T-${Date.now()}-${i}-${crypto.randomBytes(2).toString("hex")}`;
}

function makeQrToken() {
  return crypto.randomUUID();
}