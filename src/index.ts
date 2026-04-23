import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './db';
import { initializePayment, verifyPayment, webhookProcessor, checkoutPage } from './controllers/payaza';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());

// Capture raw body before JSON parsing — required for Payaza webhook HMAC (SHA512) validation
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

connectDB();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'bloomzon-payaza-service' });
});

app.post('/api/payaza/initialize', initializePayment);
app.get('/api/payaza/checkout', checkoutPage);   // Serves the Payaza web SDK HTML checkout page
app.post('/api/payaza/verify', verifyPayment);
app.post('/api/payaza/webhook', webhookProcessor);

app.listen(PORT, () => {
  console.log(`Bloomzon-payaza-service is running on port ${PORT}`);
});
