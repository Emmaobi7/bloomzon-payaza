import { Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import PaymentTransaction from '../models/PaymentTransaction';
import { clearOrderItemsFromCart } from '../helpers/cart';

const PAYAZA_PUBLIC_KEY = process.env.PAYAZA_PUBLIC_KEY;
const PAYAZA_SECRET_KEY = process.env.PAYAZA_SECRET_KEY; // Used for webhook HMAC validation only
const PAYAZA_BASE_URL = 'https://api.payaza.africa'; // Base — no /live suffix; paths include /live
// Correct public endpoint for querying transaction status (no AWS API Gateway):
const PAYAZA_TX_STATUS_PATH = '/live/card/card_charge/transaction_status';

// Auth for direct Payaza API calls: "Authorization: Payaza <Base64(PUBLIC_KEY)>"
// Only the PUBLIC_KEY is base64-encoded — no secret key needed here.
const buildPayazaHeaders = () => {
  if (!PAYAZA_PUBLIC_KEY) {
    throw new Error('PAYAZA_PUBLIC_KEY is not configured');
  }
  const encoded = Buffer.from(PAYAZA_PUBLIC_KEY).toString('base64');
  return {
    'Content-Type': 'application/json',
    Authorization: `Payaza ${encoded}`,
  };
};

const extractErrorDetails = (error: any) => {
  const status = error?.response?.status || null;
  const data = error?.response?.data ?? null;
  const headers = error?.response?.headers
    ? {
        'content-type': error.response.headers['content-type'],
        'www-authenticate': error.response.headers['www-authenticate'],
        date: error.response.headers.date,
      }
    : null;

  return {
    name: error?.name || null,
    message: error?.message || 'Unknown error',
    code: error?.code || null,
    status,
    data,
    headers,
  };
};

export const initializePayment = async (req: Request, res: Response) => {
  try {
    const { amount, currency, email, name, phone, tx_ref, order_id, user_id, redirect_url } = req.body;

    if (amount === undefined || amount === null || !currency || !email || !tx_ref) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!PAYAZA_PUBLIC_KEY) {
      return res.status(500).json({ success: false, message: 'PAYAZA_PUBLIC_KEY is not configured' });
    }

    if (amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
    }

    const uppercaseCurrency = String(currency).toUpperCase();
    const [transaction, created] = await PaymentTransaction.findOrCreate({
      where: { tx_ref },
      defaults: {
        tx_ref,
        payment_gateway: 'payaza',
        amount,
        currency: uppercaseCurrency,
        customer_email: email,
        order_id: order_id || null,
        user_id: user_id || null,
        status: 'pending',
      },
    });

    if (!created && transaction.status === 'successful') {
      return res.status(400).json({ success: false, message: 'Transaction already paid for.' });
    }

    // Payaza does not expose a server-side "create payment link" REST endpoint —
    // their hosted checkout runs via the web SDK (browser popup).
    // We serve our own HTML checkout page that embeds the Payaza web SDK and
    // auto-launches the popup. After payment the page redirects back to the app deep link.
    const selfBaseUrl = process.env.PAYAZA_SERVICE_URL || `http://localhost:${process.env.PORT || 5001}`;
    console.log('[Payaza] PAYAZA_SERVICE_URL env =', process.env.PAYAZA_SERVICE_URL);
    console.log('[Payaza] selfBaseUrl =', selfBaseUrl);
    const params = new URLSearchParams({
      merchant_key: PAYAZA_PUBLIC_KEY,
      amount: String(amount),
      currency: uppercaseCurrency,
      email: email || '',
      name: name || '',
      phone: phone || '',
      tx_ref,
      redirect_url: redirect_url || '',
    });
    const paymentUrl = `${selfBaseUrl}/api/payaza/checkout?${params.toString()}`;
    console.log('[Payaza] payment_url returned to app =', paymentUrl);

    return res.status(200).json({ success: true, payment_url: paymentUrl });
  } catch (error: any) {
    console.error('Payaza initialize failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to initialize payment' });
  }
};

// Serves a self-contained HTML page that embeds the Payaza web SDK checkout popup.
// The app's WebBrowser opens this URL; after payment the page redirects to the app deep link.
export const checkoutPage = (req: Request, res: Response) => {
  const { merchant_key, amount, currency, email, name, phone, tx_ref, redirect_url } = req.query as Record<string, string>;

  if (!merchant_key || !amount || !tx_ref) {
    return res.status(400).send('<h2>Missing payment parameters.</h2>');
  }

  const safeRedirectUrl = redirect_url || '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pay with Payaza</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; min-height: 100vh; background: #f7f8fa; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 32px 24px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 360px; width: 100%; text-align: center; }
    .logo { font-size: 36px; margin-bottom: 12px; }
    h2 { font-size: 20px; color: #111; margin-bottom: 6px; }
    .amount { font-size: 28px; font-weight: 700; color: #003B95; margin: 16px 0; }
    .sub { font-size: 13px; color: #888; margin-bottom: 24px; }
    #pay-btn { background: #003B95; color: #fff; border: none; border-radius: 10px;
               padding: 16px 32px; font-size: 17px; font-weight: 600; width: 100%;
               cursor: pointer; transition: background 0.2s; }
    #pay-btn:hover { background: #002a70; }
    #pay-btn:disabled { background: #aaa; cursor: default; }
    #status { margin-top: 16px; font-size: 13px; color: #555; min-height: 20px; }
    #err { margin-top: 12px; font-size: 13px; color: #c0392b; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">💠</div>
    <h2>Complete your payment</h2>
    <div class="amount">${currency || 'NGN'} ${amount}</div>
    <p class="sub">Ref: ${tx_ref}</p>
    <button id="pay-btn">Pay with Payaza</button>
    <div id="status">Loading secure payment…</div>
    <div id="err">Payment SDK failed to load. Please refresh the page.</div>
  </div>

  <!-- Payaza Web SDK — loaded at end of body so it's ready before our script runs -->
  <script src="https://checkout.payaza.africa/js/v1/bundle.js"></script>
  <script>
    var statusEl = document.getElementById('status');
    var errEl = document.getElementById('err');
    var btn = document.getElementById('pay-btn');

    function onClose() {
      statusEl.textContent = 'Payment window closed.';
      var redirectUrl = ${JSON.stringify(safeRedirectUrl)};
      if (redirectUrl) {
        window.location.href = redirectUrl + '?status=cancelled&tx_ref=' + encodeURIComponent(${JSON.stringify(tx_ref)});
      }
    }

    function onCallback(response) {
      console.log('Payaza callback:', JSON.stringify(response));
      var status = (response && response.status) ? response.status : 'unknown';
      var ref = (response && (response.reference || response.merchant_reference)) ? (response.reference || response.merchant_reference) : ${JSON.stringify(tx_ref)};
      statusEl.textContent = 'Payment ' + status + '. Redirecting…';
      var redirectUrl = ${JSON.stringify(safeRedirectUrl)};
      if (redirectUrl) {
        window.location.href = redirectUrl
          + '?status=' + encodeURIComponent(status)
          + '&tx_ref=' + encodeURIComponent(${JSON.stringify(tx_ref)})
          + '&reference=' + encodeURIComponent(ref);
      }
    }

    function initCheckout() {
      if (typeof PayazaCheckout === 'undefined') {
        console.error('PayazaCheckout SDK not loaded');
        errEl.style.display = 'block';
        statusEl.textContent = '';
        btn.disabled = true;
        return null;
      }
      try {
        return PayazaCheckout.setup({
          merchant_key: ${JSON.stringify(merchant_key)},
          connection_mode: PayazaCheckout.LIVE_CONNECTION_MODE,
          checkout_amount: Number(${JSON.stringify(amount)}),
          currency_code: ${JSON.stringify(currency || 'NGN')},
          email_address: ${JSON.stringify(email || '')},
          first_name: ${JSON.stringify((name || '').split(' ')[0] || '')},
          last_name: ${JSON.stringify((name || '').split(' ').slice(1).join(' ') || '')},
          phone_number: ${JSON.stringify(phone || '')},
          transaction_reference: ${JSON.stringify(tx_ref)},
          onClose: onClose,
          callback: onCallback,
        });
      } catch(e) {
        console.error('PayazaCheckout.setup error:', e);
        errEl.style.display = 'block';
        statusEl.textContent = '';
        return null;
      }
    }

    var checkout = initCheckout();

    // Wire up the button — required for browser to allow the popup (user gesture)
    btn.addEventListener('click', function () {
      if (!checkout) { checkout = initCheckout(); }
      if (checkout) {
        statusEl.textContent = 'Opening payment window…';
        checkout.showPopup();
      }
    });

    // Try to auto-open (works in WebView / in-app browser; may be blocked in desktop browser)
    if (checkout) {
      try {
        statusEl.textContent = 'Opening secure checkout…';
        checkout.showPopup();
      } catch(e) {
        console.warn('Auto-open blocked, waiting for button tap:', e);
        statusEl.textContent = 'Tap the button below to continue.';
      }
    }
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  return res.send(html);
};

export const verifyPayment = async (req: Request, res: Response) => {
  try {
    const { transaction_id, tx_ref, reference } = req.body;
    const lookupRef = tx_ref || reference;
    const externalTxId = transaction_id || reference || tx_ref;

    if (!lookupRef) {
      return res.status(400).json({ success: false, message: 'Missing tx_ref/reference' });
    }

    const existingTx = await PaymentTransaction.findOne({ where: { tx_ref: lookupRef } });
    if (!existingTx) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (existingTx.status === 'successful') {
      return res.status(200).json({ success: true, message: 'Transaction already verified previously.' });
    }

    // Correct public endpoint — wraps request in service_payload as required by Payaza's card API
    const verifyPayload = {
      service_payload: {
        transaction_reference: externalTxId || lookupRef,
      },
    };

    const response = await axios.post(`${PAYAZA_BASE_URL}${PAYAZA_TX_STATUS_PATH}`, verifyPayload, {
      headers: buildPayazaHeaders(),
      timeout: 20000,
    });

    const verificationData = response.data?.data || response.data;
    const statusRaw =
      verificationData?.status ||
      verificationData?.payment_status ||
      verificationData?.transaction_status ||
      verificationData?.paymentStatus ||
      response.data?.status;
    const verifiedAmount = Number(verificationData?.amount || existingTx.amount);
    const verifiedCurrency = String(verificationData?.currency || existingTx.currency).toUpperCase();
    const normalizedStatus = String(statusRaw || '').toLowerCase();

    if (
      ['success', 'successful', 'paid', 'completed'].includes(normalizedStatus) &&
      verifiedAmount >= Number(existingTx.amount) &&
      verifiedCurrency === String(existingTx.currency).toUpperCase()
    ) {
      await existingTx.update({
        gateway_transaction_id: String(externalTxId || verificationData?.id || lookupRef),
        status: 'successful',
      });

      if (existingTx.order_id && existingTx.user_id) {
        await clearOrderItemsFromCart(existingTx.order_id, existingTx.user_id);
      }

      return res.status(200).json({
        success: true,
        message: 'Payment verified successfully',
        data: response.data,
      });
    }

    await existingTx.update({ status: 'failed' });
    return res.status(400).json({
      success: false,
      message: 'Payment verification failed',
      data: response.data,
    });
  } catch (error: any) {
    const upstream = extractErrorDetails(error);
    console.error('Payaza verify failed:', upstream);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: upstream,
    });
  }
};

export const webhookProcessor = async (req: Request, res: Response) => {
  try {
    // Payaza sends HMAC SHA512 signature in x-payaza-signature, Base64-encoded.
    // Secret key is your PAYAZA_SECRET_KEY — do NOT base64 encode it before hashing.
    const signatureHeader = String(req.headers['x-payaza-signature'] || '');

    if (!signatureHeader) {
      return res.status(401).json({ success: false, message: 'Missing x-payaza-signature header' });
    }

    if (!PAYAZA_SECRET_KEY) {
      console.error('PAYAZA_SECRET_KEY is not configured — cannot validate webhook');
      return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
    }

    // Use raw body (captured in index.ts) so the hash is computed on the exact bytes Payaza sent
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);
    const computedSignature = crypto
      .createHmac('sha512', PAYAZA_SECRET_KEY)
      .update(rawBody, 'utf8')
      .digest('base64');

    if (computedSignature !== signatureHeader) {
      console.error('Payaza webhook signature mismatch — rejecting');
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }

    // Payaza collection webhook payload is a flat object:
    //   merchant_reference  → the tx_ref we sent when initializing
    //   transaction_reference → Payaza's own transaction ID
    //   transaction_status  → "Funds Received" | "Transaction Failed"
    //   status              → "Completed" | "Failed"
    const payload = req.body;
    const txRef = String(payload?.merchant_reference || payload?.transaction_reference || '');
    const transactionReference = String(payload?.transaction_reference || '');
    const transactionStatus = String(payload?.transaction_status || '').toLowerCase();
    const status = String(payload?.status || '').toLowerCase();

    if (!txRef) {
      console.warn('Payaza webhook: no merchant_reference in payload', payload);
      return res.status(200).json({ success: true, message: 'No reference in webhook payload' });
    }

    // Idempotency: use merchant_reference (our tx_ref) as the unique key per docs
    const tx = await PaymentTransaction.findOne({ where: { tx_ref: txRef } });

    if (!tx) {
      console.warn(`Payaza webhook: no transaction found for tx_ref: ${txRef}`);
      return res.status(200).json({ success: true, message: 'Transaction not found' });
    }

    if (tx.status === 'successful') {
      console.log(`Payaza webhook: tx ${txRef} already successful — skipping`);
      return res.status(200).json({ success: true });
    }

    // Success: transaction_status "Funds Received" + status "Completed"
    if (transactionStatus === 'funds received' && status === 'completed') {
      await tx.update({
        status: 'successful',
        gateway_transaction_id: transactionReference || txRef,
      });

      if (tx.order_id && tx.user_id) {
        await clearOrderItemsFromCart(tx.order_id, tx.user_id);
      }

      console.log(`Payaza webhook: tx ${txRef} marked successful`);
    } else if (transactionStatus === 'transaction failed' || status === 'failed') {
      await tx.update({ status: 'failed' });
      console.warn(`Payaza webhook: tx ${txRef} marked failed`);
    } else {
      console.log(`Payaza webhook: unhandled status for tx ${txRef} — transaction_status: ${transactionStatus}, status: ${status}`);
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    const upstream = extractErrorDetails(error);
    console.error('Payaza webhook failed:', upstream);
    return res.status(500).json({
      success: false,
      message: 'Webhook processing failed',
      error: upstream,
    });
  }
};
