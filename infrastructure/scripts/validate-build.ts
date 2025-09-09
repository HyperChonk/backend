#!/usr/bin/env ts-node

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const execAsync = promisify(exec);

interface ValidationResult {
    step: string;
    success: boolean;
    message: string;
    duration?: number;
    details?: string;
}

class BuildValidator {
    private results: ValidationResult[] = [];
    private verbose: boolean = false;
    private exitOnError: boolean = true;

    constructor(options: { verbose?: boolean; exitOnError?: boolean } = {}) {
        this.verbose = options.verbose || false;
        this.exitOnError = options.exitOnError !== false;
    }

    private log(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info') {
        if (!this.verbose && level === 'info') return;
        
        const colors = {
            info: chalk.blue,
            success: chalk.green,
            warning: chalk.yellow,
            error: chalk.red
        };
        
        console.log(colors[level](message));
    }

    private async runStep(step: string, command: string, description: string): Promise<ValidationResult> {
        const startTime = Date.now();
        this.log(`🔍 ${description}...`, 'info');
        
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: process.cwd(),
                timeout: 5 * 60 * 1000 // 5 minute timeout
            });
            
            const duration = Date.now() - startTime;
            const result: ValidationResult = {
                step,
                success: true,
                message: description,
                duration
            };
            
            this.log(`✅ ${description} (${duration}ms)`, 'success');
            
            if (this.verbose && stdout) {
                this.log(`Output: ${stdout.substring(0, 500)}`, 'info');
            }
            
            this.results.push(result);
            return result;
            
        } catch (error: any) {
            const duration = Date.now() - startTime;
            const result: ValidationResult = {
                step,
                success: false,
                message: `${description} failed`,
                duration,
                details: error.message
            };
            
            this.log(`❌ ${description} failed (${duration}ms)`, 'error');
            if (error.stdout) {
                this.log(`Stdout: ${error.stdout.substring(0, 1000)}`, 'error');
            }
            if (error.stderr) {
                this.log(`Stderr: ${error.stderr.substring(0, 1000)}`, 'error');
            }
            
            this.results.push(result);
            return result;
        }
    }

    async validateFileStructure(): Promise<ValidationResult> {
        const requiredFiles = [
            'tsconfig.json',
            'package.json',
            'lib/app.ts',
            'cdk.json'
        ];
        
        const missingFiles = requiredFiles.filter(file => !existsSync(join(process.cwd(), file)));
        
        if (missingFiles.length > 0) {
            return {
                step: 'file-structure',
                success: false,
                message: 'Missing required files',
                details: `Missing files: ${missingFiles.join(', ')}`
            };
        }
        
        this.log('✅ All required files present', 'success');
        return {
            step: 'file-structure',
            success: true,
            message: 'All required files present'
        };
    }

    async validateTypeScript(): Promise<ValidationResult> {
        return this.runStep(
            'typescript-compile',
            'npx tsc --noEmit',
            'TypeScript compilation check'
        );
    }

    async validateCDKSynth(): Promise<ValidationResult> {
        // Test synthesis for all environments to catch environment-specific issues
        const environments = ['development', 'staging', 'production'];
        const results = [];
        
        for (const env of environments) {
            const result = await this.runStep(
                `cdk-synth-${env}`,
                `npx cdk synth --all -c environment=${env} > /dev/null`,
                `CDK synthesis for ${env} environment`
            );
            results.push(result);
            
            // If any environment fails and we're set to exit on error, stop here
            if (!result.success && this.exitOnError) {
                return result;
            }
        }
        
        const allSucceeded = results.every(r => r.success);
        const failedEnvs = results.filter(r => !r.success).map(r => r.step.replace('cdk-synth-', ''));
        
        return {
            step: 'cdk-synth-all',
            success: allSucceeded,
            message: allSucceeded 
                ? 'CDK synthesis successful for all environments'
                : `CDK synthesis failed for: ${failedEnvs.join(', ')}`,
            details: results.map(r => `${r.step}: ${r.success ? 'OK' : 'FAILED'}`).join(', ')
        };
    }

    async validateNodeModules(): Promise<ValidationResult> {
        if (!existsSync(join(process.cwd(), 'node_modules'))) {
            return {
                step: 'node-modules',
                success: false,
                message: 'node_modules directory not found',
                details: 'Run npm install first'
            };
        }
        
        return this.runStep(
            'dependencies-check',
            'npm ls --depth=0 > /dev/null',
            'Dependency integrity check'
        );
    }

    async validateLinting(): Promise<ValidationResult> {
        // Check if we have any linting configuration
        const lintConfigs = ['.eslintrc.js', '.eslintrc.json', 'eslint.config.js'];
        const hasLintConfig = lintConfigs.some(config => existsSync(join(process.cwd(), config)));
        
        if (!hasLintConfig) {
            this.log('⚠️  No ESLint configuration found, skipping linting', 'warning');
            return {
                step: 'linting',
                success: true,
                message: 'Linting skipped (no configuration found)'
            };
        }
        
        return this.runStep(
            'eslint',
            'npx eslint lib/ scripts/ --ext .ts',
            'ESLint validation'
        );
    }

    async validateTests(): Promise<ValidationResult> {
        // Check if tests exist
        const testDirs = ['test', 'tests', '__tests__'];
        const hasTests = testDirs.some(dir => existsSync(join(process.cwd(), dir)));
        
        if (!hasTests) {
            this.log('⚠️  No test directories found, skipping tests', 'warning');
            return {
                step: 'tests',
                success: true,
                message: 'Tests skipped (no test directories found)'
            };
        }
        
        return this.runStep(
            'jest',
            'npm run test:unit',
            'Unit tests execution'
        );
    }

    async run(): Promise<boolean> {
        console.log(chalk.blue.bold('🔍 CDK Infrastructure Build Validation'));
        console.log(chalk.gray('Validating TypeScript compilation and CDK synthesis...\n'));
        
        const startTime = Date.now();
        
        // Run validation steps
        const steps = [
            () => this.validateFileStructure(),
            () => this.validateNodeModules(),
            () => this.validateTypeScript(),
            () => this.validateCDKSynth(),
            () => this.validateLinting(),
            () => this.validateTests()
        ];
        
        for (const step of steps) {
            const result = await step();
            
            if (!result.success && this.exitOnError) {
                this.printSummary(Date.now() - startTime);
                process.exit(1);
            }
        }
        
        this.printSummary(Date.now() - startTime);
        
        const allSucceeded = this.results.every(r => r.success);
        if (!allSucceeded && this.exitOnError) {
            process.exit(1);
        }
        
        return allSucceeded;
    }

    private printSummary(totalDuration: number) {
        console.log('\n' + chalk.blue.bold('📊 Build Validation Summary'));
        console.log(chalk.gray('=' .repeat(50)));
        
        const successful = this.results.filter(r => r.success).length;
        const failed = this.results.filter(r => !r.success).length;
        
        this.results.forEach(result => {
            const icon = result.success ? '✅' : '❌';
            const duration = result.duration ? ` (${result.duration}ms)` : '';
            console.log(`${icon} ${result.message}${duration}`);
            
            if (!result.success && result.details) {
                console.log(chalk.red(`   ${result.details}`));
            }
        });
        
        console.log(chalk.gray('-'.repeat(50)));
        console.log(
            `${chalk.green(`✅ ${successful} passed`)} | ` +
            `${failed > 0 ? chalk.red(`❌ ${failed} failed`) : chalk.gray('❌ 0 failed')} | ` +
            `${chalk.blue(`⏱️  ${totalDuration}ms total`)}`
        );
        
        if (failed === 0) {
            console.log(chalk.green.bold('\n🎉 All validations passed! CDK infrastructure is ready to deploy.'));
        } else {
            console.log(chalk.red.bold('\n💥 Some validations failed. Please fix the issues before deploying.'));
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose') || args.includes('-v');
    const continueOnError = args.includes('--continue-on-error') || args.includes('-c');
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage: npm run validate:build [options]

Options:
  --verbose, -v              Show detailed output
  --continue-on-error, -c    Continue validation even if steps fail
  --help, -h                 Show this help message

Examples:
  npm run validate:build                    # Run basic validation
  npm run validate:build --verbose         # Run with detailed output
  npm run validate:build --continue-on-error  # Run all checks regardless of failures
        `);
        return;
    }
    
    const validator = new BuildValidator({
        verbose,
        exitOnError: !continueOnError
    });
    
    await validator.run();
}

// Only run if this script is executed directly
if (require.main === module) {
    main().catch((error) => {
        console.error(chalk.red('💥 Validation failed with error:'), error.message);
        process.exit(1);
    });
}

export { BuildValidator };