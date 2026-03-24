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

const frontendPath = path.resolve(__dirname, "../frontend");
console.log("📁 FRONTEND PATH:", frontendPath);

app.use(cors());
app.use(express.json());
app.use(express.static(frontendPath));

app.post("/create-checkout-session", async (req, res) => {
  console.log("📩 BODY RECIBIDO:", req.body);
  try {
    let { eventSlug, buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;
    ticketQuantity = Number(ticketQuantity);

    if(!eventSlug || !buyerName || !buyerEmail || !ticketQuantity){
      console.log("❌ Datos incompletos:", { eventSlug, buyerName, buyerEmail, buyerPhone, ticketQuantity });
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const { data: event } = await supabase
      .from("events")
      .select("*")
      .eq("slug", eventSlug)
      .single();

    if(!event) return res.status(500).json({ error: "Evento no encontrado" });
    if(ticketQuantity <= 0) return res.status(400).json({ error: "Cantidad inválida" });

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

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      metadata: { order_id: order.id, ticket_quantity: ticketQuantity, buyer_name: buyerName },
      line_items: [{
        quantity: ticketQuantity,
        price_data: {
          currency: "mxn",
          unit_amount: event.unit_price * 100,
          product_data: { name: event.name, description: event.description }
        }
      }],
      success_url: `${process.env.APP_URL}/confirmacion?order=${order.id}`,
      cancel_url: `${process.env.APP_URL}/error.html`,
    });

    await supabase.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);
    res.json({ checkoutUrl: session.url });

  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// otros endpoints (confirmación, validate) se mantienen igual

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 SERVER RUNNING ON", PORT));