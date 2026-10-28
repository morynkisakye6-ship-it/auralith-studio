import { PLANS, planAmount, proCurrency } from './_pro.js';

// Public: lets the app show exactly the price/currency the server will charge.
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });
  const plans = {};
  Object.entries(PLANS).forEach(([id, p]) => {
    const amount = planAmount(id);
    if (amount) plans[id] = { label: p.label, amount, days: p.days };
  });
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ currency: proCurrency(), plans });
}
