const express = require("express");
const mongoose = require("mongoose");
const amqp = require("amqplib");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());

// MongoDB connection
mongoose.connect(
  process.env.MONGODB_URI || "mongodb://localhost:27017/payments",
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
);

// Payment Schema
const paymentSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  userId: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: "usd" },
  status: {
    type: String,
    enum: ["PENDING", "COMPLETED", "FAILED", "REFUNDED"],
    default: "PENDING",
  },
  stripePaymentId: String,
  stripeClientSecret: String,
  refundId: String,
  errorMessage: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Payment = mongoose.model("Payment", paymentSchema);

// RabbitMQ connection
let channel;
async function connectQueue() {
  try {
    const connection = await amqp.connect(
      process.env.RABBITMQ_URL || "amqp://localhost"
    );
    channel = await connection.createChannel();

    await channel.assertQueue("order_created");
    await channel.assertQueue("payment_completed");
    await channel.assertQueue("payment_failed");

    // Listen for order created events
    channel.consume("order_created", async (data) => {
      const { orderId, userId, totalAmount } = JSON.parse(data.content);
      try {
        // Create Stripe Payment Intent
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(totalAmount * 100), // Convert to cents
          currency: "usd",
          metadata: { orderId, userId },
        });

        // Save payment record
        const payment = new Payment({
          orderId,
          userId,
          amount: totalAmount,
          stripePaymentId: paymentIntent.id,
          stripeClientSecret: paymentIntent.client_secret,
        });
        await payment.save();

        channel.ack(data);
      } catch (error) {
        console.error("Error processing payment:", error);
        channel.ack(data);
      }
    });
  } catch (error) {
    console.error("Error connecting to RabbitMQ:", error);
  }
}
connectQueue();

// Auth middleware
const auth = async (req, res, next) => {
  try {
    const token = req.header("Authorization").replace("Bearer ", "");
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key"
    );
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).send({ error: "Please authenticate." });
  }
};

// Create payment intent
app.post("/payments/create-intent", auth, async (req, res) => {
  try {
    const { orderId, amount } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd",
      metadata: { orderId, userId: req.userId },
    });

    const payment = new Payment({
      orderId,
      userId: req.userId,
      amount,
      stripePaymentId: paymentIntent.id,
      stripeClientSecret: paymentIntent.client_secret,
    });
    await payment.save();

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(400).json({ error: "Error creating payment intent" });
  }
});

// Confirm payment
app.post("/payments/confirm/:paymentId", auth, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.paymentId,
      userId: req.userId,
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    const paymentIntent = await stripe.paymentIntents.confirm(
      payment.stripePaymentId
    );

    payment.status = "COMPLETED";
    payment.updatedAt = new Date();
    await payment.save();

    // Publish payment completed event
    channel.sendToQueue(
      "payment_completed",
      Buffer.from(
        JSON.stringify({
          orderId: payment.orderId,
          status: "PAID",
        })
      )
    );

    res.json({ status: "Payment confirmed" });
  } catch (error) {
    res.status(400).json({ error: "Error confirming payment" });
  }
});

// Get payment status
app.get("/payments/:paymentId", auth, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.paymentId,
      userId: req.userId,
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    res.json(payment);
  } catch (error) {
    res.status(500).json({ error: "Error fetching payment" });
  }
});

// Refund payment
app.post("/payments/:paymentId/refund", auth, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.paymentId,
      userId: req.userId,
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    const refund = await stripe.refunds.create({
      payment_intent: payment.stripePaymentId,
    });

    payment.status = "REFUNDED";
    payment.refundId = refund.id;
    payment.updatedAt = new Date();
    await payment.save();

    res.json({ status: "Payment refunded" });
  } catch (error) {
    res.status(400).json({ error: "Error refunding payment" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Payments service running on port ${port}`);
});
