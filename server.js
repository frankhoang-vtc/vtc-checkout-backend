/* ============================================================
   VTC Checkout Backend
   Sits between the checkout.html page on your website and
   Match-Trade's Broker-API. Holds the API key safely on the
   server side (never exposed to the browser).

   Required environment variables (set these in Render, NOT here):
     MATCHTRADE_API_KEY   - your Bearer token
     MATCHTRADE_BASE_URL  - e.g. https://broker-api-prop.match-trade.com
     ALLOWED_ORIGIN        - your website's address, e.g.
                             https://verifiedtradercapital.com
   ============================================================ */

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

const API_KEY = process.env.MATCHTRADE_API_KEY;
const BASE_URL = process.env.MATCHTRADE_BASE_URL;

function mtClient() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
}

// Simple health check - visiting this URL in a browser should say "OK"
app.get('/', (req, res) => {
  res.send('VTC checkout backend is running.');
});

/* ------------------------------------------------------------
   STEP 1: Check if a CRM account already exists for this email
   ------------------------------------------------------------ */
app.post('/api/checkout/check-customer', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const client = mtClient();
    const response = await client.get(`/v1/accounts/by-email/${encodeURIComponent(email)}`);

    // If Match-Trade returns account data, it exists
    return res.json({ exists: true, crmAccountUuid: response.data.uuid || response.data.id });

  } catch (err) {
    if (err.response && err.response.status === 404) {
      // Not found = no existing account, which is fine
      return res.json({ exists: false });
    }
    console.error('check-customer error:', err.response ? err.response.data : err.message);
    return res.status(500).json({ error: 'check-customer failed' });
  }
});

/* ------------------------------------------------------------
   STEP 2: Create the CRM account (no trading account yet)
   - Auto-generates a password (client never types one on the
     public checkout page; they'll set/reset it via Match-Trade's
     own login flow later).
   - Self-healing: if Match-Trade says this email already has an
     account (409 conflict), look that account up and reuse it
     instead of failing the checkout - a client should be able to
     buy multiple challenges with the same email without issue.
   ------------------------------------------------------------ */
function generatePassword() {
  // 16-character random password combining letters, numbers, symbols
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pw = '';
  for (let i = 0; i < 16; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

async function findExistingAccountUuid(client, email) {
  const lookup = await client.get(`/v1/accounts/by-email/${encodeURIComponent(email)}`);
  return lookup.data.uuid || lookup.data.id;
}

app.post('/api/checkout/create-customer', async (req, res) => {
  const { firstName, lastName, email, phone, country, address } = req.body;
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'firstName, lastName, and email are required' });
  }

  const client = mtClient();

  try {
    const response = await client.post('/v1/accounts', {
      email,
      password: generatePassword(),
      personalDetails: {
        firstname: firstName,
        lastname: lastName,
        phone,
        country,
        address
      }
      // NOTE: no offerUuid/challengeUuid here on purpose -
      // this call only creates the CRM user account.
    });

    return res.json({ crmAccountUuid: response.data.uuid || response.data.id, reused: false });

  } catch (err) {
    const isConflict = err.response && err.response.status === 409;

    if (isConflict) {
      // Email already has an account - look it up and reuse it
      // instead of failing the client's checkout.
      try {
        const crmAccountUuid = await findExistingAccountUuid(client, email);
        return res.json({ crmAccountUuid, reused: true });
      } catch (lookupErr) {
        console.error('create-customer lookup-after-conflict error:', lookupErr.response ? lookupErr.response.data : lookupErr.message);
        return res.status(500).json({ error: 'create-customer failed' });
      }
    }

    console.error('create-customer error:', err.response ? err.response.data : err.message);
    return res.status(500).json({ error: 'create-customer failed' });
  }
});

/* ------------------------------------------------------------
   STEP 3: Create the Prop Trading Account tied to ONE challenge
   ------------------------------------------------------------ */
app.post('/api/checkout/create-prop-account', async (req, res) => {
  try {
    const { crmAccountUuid, challengeUuid, instantlyActive, phaseStep, discountCode } = req.body;
    if (!crmAccountUuid || !challengeUuid) {
      return res.status(400).json({ error: 'crmAccountUuid and challengeUuid are required' });
    }

    const client = mtClient();
    const response = await client.post('/v2/prop/prop-accounts', {
      challengeUuid,
      crmAccountUuid,
      instantlyActive: instantlyActive === true, // false = "Awaiting Payment"
      phaseStep: phaseStep || 1,
      ...(discountCode ? { discountCode } : {})
    });

    return res.json(response.data);

  } catch (err) {
    console.error('create-prop-account error:', err.response ? err.response.data : err.message);
    return res.status(500).json({ error: 'create-prop-account failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VTC checkout backend listening on port ${PORT}`);
});
