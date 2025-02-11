const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

const app = express();

// Enable CORS
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

app.use(limiter);

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Service routes
const routes = {
  users: {
    target: "http://users-service:3000",
    pathRewrite: { "^/api/users": "" },
  },
  orders: {
    target: "http://orders-service:3000",
    pathRewrite: { "^/api/orders": "" },
  },
  payments: {
    target: "http://payments-service:3000",
    pathRewrite: { "^/api/payments": "" },
  },
};

// Setup proxy middleware
Object.keys(routes).forEach((route) => {
  app.use(`/api/${route}`, createProxyMiddleware(routes[route]));
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something broke!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});
