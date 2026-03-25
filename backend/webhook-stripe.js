require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");
const bodyParser = require("body-parser");

const app = express();

// Conexión a Supabase
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe necesita body raw para verificar la firma
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Manejar evento de pago completado
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.order_id;

    try {
      // Buscar la orden
      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .single();

      if (!order) {
        console.error("Orden no encontrada:", orderId);
        return res.status(404).send("Orden no encontrada");
      }

      // Marcar como pagada
      await supabase
        .from("orders")
        .update({ payment_status: "paid" })
        .eq("id", orderId);

      // Generar tickets con QR
      const tickets = Array.from({ length: order.ticket_quantity }).map((_, i) => {
        const ticketCode = `PS-T-${Date.now()}-${i}-${crypto.randomBytes(2).toString("hex")}`;
        const qrToken = crypto.randomUUID();
        return { 
          order_id: order.id,
          event_id: order.event_id,
          ticket_code: ticketCode,
          qr_token: qrToken,
          status: "valid"
        };
      });

      // Guardar tickets en Supabase
      await supabase.from("tickets").insert(tickets);

      // Generar QR para cada ticket y guardar URL en Supabase
      const ticketsWithQr = await Promise.all(
        tickets.map(async t => {
          const qr = await QRCode.toDataURL(`${process.env.APP_URL}/validate?token=${t.qr_token}`);
          await supabase.from("tickets").update({ qr }).eq("ticket_code", t.ticket_code);
          return t;
        })
      );

      console.log("✅ Tickets generados y QR guardados para orden:", orderId);
    } catch (err) {
      console.error("Error procesando webhook:", err);
      return res.status(500).send("Error procesando webhook");
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Webhook Stripe escuchando en puerto ${PORT}`));