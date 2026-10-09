// Static demo data; replace with common models when implementing persistence.
const items = [{ productId: 1, name: 'Keyboard', quantity: 2, unitPrice: 1499 }];

export function getCart(req, res) {
  const { limit } = req.validatedQuery;
  res.json({ demo: true, data: items.slice(0, limit) });
}
