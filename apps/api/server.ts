import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { ApolloServerPluginUsageReporting } from '@apollo/server/plugin/usageReporting';
import { setupExpressErrorHandler } from '@sentry/node';
import express from 'express';
import helmet from 'helmet';
import * as http from 'http';
import { env } from '../env';
import { apolloSentryPlugin } from './apollo/sentry-plugin';
import { schema } from './gql/generated-schema-ast';
import { ResolverContext, resolverContext } from './gql/resolver-context';
import { resolvers } from './gql/resolvers';
import { corsMiddleware, lowerCaseMiddleware, sessionMiddleware } from './middleware';
import { loadRestRoutes } from './rest-routes';

// Initialize structured logging for all environments
// In development: readable console output
// In staging/production: structured JSON for Loki
// const { enableGlobalStructuredLogging } = require('../simple-logging');
// enableGlobalStructuredLogging();
// console.log(`✅ Structured logging enabled for API service (${process.env.DEPLOYMENT_ENV})`);

const configureHelmet = (app: express.Express) => {
    app.use(helmet.dnsPrefetchControl());
    app.use(helmet.expectCt());
    app.use(helmet.frameguard());
    app.use(helmet.hidePoweredBy());
    app.use(helmet.hsts());
    app.use(helmet.ieNoOpen());
    app.use(helmet.noSniff());
    app.use(helmet.originAgentCluster());
    app.use(helmet.permittedCrossDomainPolicies());
    app.use(helmet.referrerPolicy());
    app.use(helmet.xssFilter());
};

const configureMiddlewares = (app: express.Express) => {
    app.use(corsMiddleware);
    app.use(sessionMiddleware);
    app.use(lowerCaseMiddleware);
};

const configureApolloServer = async (httpServer: http.Server, app: express.Express) => {
    const plugins = [ApolloServerPluginDrainHttpServer({ httpServer }), apolloSentryPlugin];

    // Enable GraphQL playground/sandbox in all environments
    plugins.push(ApolloServerPluginLandingPageLocalDefault());

    if (process.env.APOLLO_SCHEMA_REPORTING === 'true') {
        plugins.push(
            ApolloServerPluginUsageReporting({
                sendVariableValues: { all: true },
                sendHeaders: { all: true },
            }),
        );
    }

    const server = new ApolloServer<ResolverContext>({
        resolvers,
        typeDefs: schema,
        introspection: true,
        cache: 'bounded',
        plugins,
    });

    await server.start();

    // const mockedServer = new ApolloServer<ResolverContext>({
    //     resolvers: mockedSubgraphV2Resolvers,
    //     typeDefs: schema,
    //     introspection: true,
    //     plugins,
    // });

    // await mockedServer.start();

    app.use(
        '/graphql',
        express.json(),
        expressMiddleware(server, {
            context: async ({ req }) => resolverContext(req),
        }),
    );

    // app.use(
    //     '/graphql/v2_mock',
    //     express.json(),
    //     expressMiddleware(mockedServer, {
    //         context: async ({ req }) => resolverContext(req),
    //     }),
    // );

    return server;
};

export const startApiServer = async () => {
    const app = express();

    loadRestRoutes(app);
    setupExpressErrorHandler(app);
    configureHelmet(app);
    configureMiddlewares(app);

    const httpServer = http.createServer(app);

    await configureApolloServer(httpServer, app);

    await new Promise<void>((resolve) => httpServer.listen({ port: env.PORT }, resolve));
    console.log(`🚀 Server ready at http://localhost:${env.PORT}/graphql`);
    console.log(`🚀 Mocked Server ready at http://localhost:${env.PORT}/graphql/v2_mock`);
};
