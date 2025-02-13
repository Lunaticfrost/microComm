const express = require("express");
const mongoose = require("mongoose");
const amqp = require("amqplib");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

// MongoDB connection
mongoose.connect(
  process.env.MONGODB_URI || "mongodb://localhost:27017/orders",
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
);

// Order Schema
const orderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  items: [
    {
      productId: { type: String, required: true },
      quantity: { type: Number, required: true },
      price: { type: Number, required: true },
    },
  ],
  totalAmount: { type: Number, required: true },
  status: {
    type: String,
    enum: [
      "PENDING",
      "PAID",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
    ],
    default: "PENDING",
  },
  shippingAddress: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Order = mongoose.model("Order", orderSchema);

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

    // Listen for payment completed events
    channel.consume("payment_completed", async (data) => {
      const { orderId, status } = JSON.parse(data.content);
      await Order.findByIdAndUpdate(orderId, { status: status });
      channel.ack(data);
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

// Create order
app.post("/orders", auth, async (req, res) => {
  try {
    const { items, shippingAddress } = req.body;

    // Calculate total amount
    const totalAmount = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const order = new Order({
      userId: req.userId,
      items,
      totalAmount,
      shippingAddress,
      status: "PENDING",
    });

    await order.save();

    // Publish order created event
    channel.sendToQueue(
      "order_created",
      Buffer.from(
        JSON.stringify({
          orderId: order._id,
          userId: req.userId,
          totalAmount,
          items,
        })
      )
    );

    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: "Error creating order" });
  }
});

// Get user's orders
app.get("/orders", auth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.userId });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: "Error fetching orders" });
  }
});

// Get specific order
app.get("/orders/:id", auth, async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: "Error fetching order" });
  }
});

// Cancel order
app.post("/orders/:id/cancel", auth, async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.status !== "PENDING") {
      return res.status(400).json({ error: "Order cannot be cancelled" });
    }

    order.status = "CANCELLED";
    await order.save();

    res.json(order);
  } catch (error) {
    res.status(500).json({ error: "Error cancelling order" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Orders service running on port ${port}`);
});
