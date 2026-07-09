import type { Request, Response, NextFunction } from 'express';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, error: 'not_found', path: req.path });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error('Unhandled error:', err);
  const status = err?.status ?? 500;
  res.status(status).json({
    success: false,
    error: status === 500 ? 'internal_server_error' : (err?.message ?? 'error')
  });
}

/** Wraps an async route handler so thrown errors reach errorHandler instead of crashing the process. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
