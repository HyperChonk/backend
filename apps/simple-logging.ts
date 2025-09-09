/**
 * Simple Logging Enhancement for Balancer V3 Backend
 *
 * This provides minimal enhancements to the existing console.log approach
 * without requiring major code changes throughout the codebase.
 */

interface LogContext {
    timestamp?: string;
    level?: string;
    job?: string;
    chain?: string;
    requestId?: string;
    duration?: number;
    phase?: 'start' | 'progress' | 'complete' | 'failed' | 'skip';
}

// CRITICAL: Save the REAL original console methods at module load time
// This must happen before any console replacement occurs
const ORIGINAL_CONSOLE = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
};

// Recursion protection flag
let isLogging = false;

/**
 * TEMPORARILY DISABLED Enhanced console - using basic logging for debugging
 * Ensures consistent logging format across development, staging, and production
 */
class EnhancedConsole {
    private service = 'balancer-v3-backend';
    private environment = process.env.DEPLOYMENT_ENV || 'development';

    /**
     * Extract context from log message patterns
     */
    private extractContext(message: string, ...args: any[]): LogContext {
        const context: LogContext = {
            timestamp: new Date().toISOString(),
        };

        // Extract job information from common patterns
        const jobMatch = message.match(/(?:Start job|Successful job|Error job|Skip job)\s+([^-\s]+)-([^-\s]+)/);
        if (jobMatch) {
            context.job = jobMatch[1];
            context.chain = jobMatch[2];

            if (message.includes('Start job')) context.phase = 'start';
            else if (message.includes('Successful job')) context.phase = 'complete';
            else if (message.includes('Error job')) context.phase = 'failed';
            else if (message.includes('Skip job')) context.phase = 'skip';
        }

        // Extract duration from arguments
        if (args.length > 0 && typeof args[0] === 'number') {
            context.duration = args[0] * 1000; // Convert seconds to milliseconds
        }

        return context;
    }

    private structuredLog(level: string, message: string, ...args: any[]) {
        // CRITICAL: Prevent infinite recursion
        if (isLogging) {
            // Use direct stdout to avoid any console replacement
            process.stdout.write(`[RECURSION_PROTECTION] ${level}: ${message}\n`);
            return;
        }

        try {
            isLogging = true;

            // TEMPORARILY DISABLED: Use basic console logging instead of structured JSON
            // This helps us debug if the structured logging is causing the Grafana forwarding issues
            const timestamp = new Date().toISOString();
            const simpleMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

            if (args.length > 0) {
                ORIGINAL_CONSOLE.log(simpleMessage, ...args);
            } else {
                ORIGINAL_CONSOLE.log(simpleMessage);
            }

            // OLD STRUCTURED VERSION (commented out for debugging):
            /*
            const context = this.extractContext(message, ...args);
            const logEntry = {
                timestamp: context.timestamp,
                level,
                msg: message,
                service: this.service,
                environment: this.environment,
                ...context,
                // Include additional args as metadata
                ...(args.length > 0 ? { meta: args } : {}),
            };

            // Always use the ORIGINAL console methods to prevent recursion
            const jsonOutput = JSON.stringify(logEntry);
            ORIGINAL_CONSOLE.log(jsonOutput);
            */
        } catch (error) {
            // Last resort: use process.stdout directly
            process.stdout.write(`[LOG_ERROR] ${level}: ${message}\n`);
            if (error instanceof Error) {
                process.stderr.write(`[LOG_ERROR_DETAILS] ${error.message}\n`);
            }
        } finally {
            isLogging = false;
        }
    }

    log(message: string, ...args: any[]) {
        this.structuredLog('info', message, ...args);
    }

    info(message: string, ...args: any[]) {
        this.structuredLog('info', message, ...args);
    }

    warn(message: string, ...args: any[]) {
        this.structuredLog('warn', message, ...args);
    }

    error(message: string, ...args: any[]) {
        this.structuredLog('error', message, ...args);
    }

    debug(message: string, ...args: any[]) {
        this.structuredLog('debug', message, ...args);
    }
}

/**
 * Simple job logger for sync operations
 * Minimal wrapper that enhances existing patterns
 */
export class SimpleJobLogger {
    constructor(private jobName: string, private chainId: string, private requestId?: string) {
        this.requestId = requestId || `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    start(message?: string) {
        enhancedConsole.log(message || `Start job ${this.jobName}-${this.chainId}-start`);
    }

    complete(durationSeconds?: number, message?: string) {
        const msg = message || `Successful job ${this.jobName}-${this.chainId}-done`;
        if (durationSeconds) {
            enhancedConsole.log(msg, durationSeconds);
        } else {
            enhancedConsole.log(msg);
        }
    }

    error(error: Error | string, durationSeconds?: number) {
        const errorMsg = typeof error === 'string' ? error : error.message;
        const msg = `Error job ${this.jobName}-${this.chainId}-error`;

        if (durationSeconds) {
            enhancedConsole.error(msg, durationSeconds, errorMsg);
        } else {
            enhancedConsole.error(msg, errorMsg);
        }
    }

    skip(message?: string) {
        enhancedConsole.log(message || `Skip job ${this.jobName}-${this.chainId}-skip`);
    }

    progress(message: string, current?: number, total?: number) {
        if (current !== undefined && total !== undefined) {
            const percentage = Math.round((current / total) * 100);
            enhancedConsole.log(`${message} (${current}/${total} - ${percentage}%)`);
        } else {
            enhancedConsole.log(message);
        }
    }
}

// Export enhanced console instance
export const enhancedConsole = new EnhancedConsole();

// Factory function for job loggers
export function createJobLogger(jobName: string, chainId: string, requestId?: string): SimpleJobLogger {
    return new SimpleJobLogger(jobName, chainId, requestId);
}

// Global replacement for consistent structured logging across all environments
export function enableGlobalStructuredLogging() {
    // TEMPORARILY DISABLED for debugging Grafana forwarding issues
    console.warn('NOTICE: Global structured logging is temporarily disabled for debugging');
    return;

    // OLD IMPLEMENTATION (commented out):
    /*
    // Safety check: prevent multiple replacements
    if ((console as any)._enhanced) {
        ORIGINAL_CONSOLE.warn('Console already enhanced, skipping replacement');
        return;
    }

    // Mark console as enhanced
    (console as any)._enhanced = true;

    // Store original methods for reference (but don't rely on them for output)
    (console as any)._original = { ...ORIGINAL_CONSOLE };

    // Replace console methods with enhanced versions
    console.log = (message: any, ...args: any[]) => {
        enhancedConsole.log(String(message), ...args);
    };

    console.error = (message: any, ...args: any[]) => {
        enhancedConsole.error(String(message), ...args);
    };

    console.warn = (message: any, ...args: any[]) => {
        enhancedConsole.warn(String(message), ...args);
    };

    console.info = (message: any, ...args: any[]) => {
        enhancedConsole.info(String(message), ...args);
    };

    console.debug = (message: any, ...args: any[]) => {
        enhancedConsole.debug(String(message), ...args);
    };
    */
}

export default enhancedConsole;
