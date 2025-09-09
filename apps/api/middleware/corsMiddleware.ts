import { NextFunction, Request, Response } from 'express';

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-Requested-With,Authorization,Content-Type,x-graphql-client-name,x-graphql-client-version',
    );

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    next();
}
