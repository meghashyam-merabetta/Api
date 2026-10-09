export function validateBody(schema) {
  return (req, _res, next) => {
    req.validated = schema.parse(req.body);
    next();
  };
}

export function validateParams(schema) {
  return (req, _res, next) => {
    req.validatedParams = schema.parse(req.params);
    next();
  };
}

export function validateQuery(schema) {
  return (req, _res, next) => {
    req.validatedQuery = schema.parse(req.query);
    next();
  };
}
