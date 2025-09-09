import { NextFunction, Request, Response } from 'express';
import {
    initRequestScopedContext,
    setRequestScopedContextValue,
} from '../../../modules/context/request-scoped-context';
import { isChainWhitelisted } from '../../../modules/network/whitelisted-chains';

function getHeader(req: Request, key: string): string | undefined {
    const value = req.headers[key.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

export async function sessionMiddleware(req: Request, res: Response, next: NextFunction) {
    const chainId = getHeader(req, 'ChainId');

    if (chainId && isChainWhitelisted(chainId)) {
        initRequestScopedContext();
        setRequestScopedContextValue('chainId', chainId);
        next();
    } else if (chainId) {
        // If a chainId is provided but not whitelisted, we can reject it.
        // For now, we'll just not set it in the context, resolvers will handle it.
        // A stricter approach would be to return an error here.
        console.warn(`Request received for non-whitelisted chain via header: ${chainId}`);
        next();
    } else {
        next();
    }
}
