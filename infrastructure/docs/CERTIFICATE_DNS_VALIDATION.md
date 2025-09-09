# Certificate DNS Validation Guide

This guide explains how to set up DNS validation for SSL certificates in the HyperChonk infrastructure.

## Overview

The infrastructure uses AWS Certificate Manager (ACM) to provision SSL/TLS certificates for the API endpoints. These certificates require DNS validation, which involves adding specific DNS records to prove domain ownership.

## Certificate Configuration

### Production Environment

-   **Domain**: `api.hyperchonk.com`
-   **Root Domain**: `hyperchonk.com`
-   **Certificate Stack**: Automatically creates certificate with DNS validation

### Staging Environment

-   **Domain**: `staging-api.hyperchonk.com`
-   **Root Domain**: `hyperchonk.com`
-   **Certificate Stack**: Automatically creates certificate with DNS validation

### Development Environment

-   **Domain**: `dev-api.hyperchonk.com`
-   **Root Domain**: `hyperchonk.com`
-   **Certificate Stack**: Automatically creates certificate with DNS validation

## DNS Validation Process

### 1. Certificate Creation

When the CertificateStack is deployed, it:

-   Creates an ACM certificate for the specified domain
-   Uses the Route53 hosted zone for automatic DNS validation
-   Generates DNS validation records that need to be added to your DNS provider

### 2. Retrieving Validation Records

Use the provided script to get the DNS validation records:

```bash
# For production
./infrastructure/scripts/get-certificate-validation-records.sh production

# For staging
./infrastructure/scripts/get-certificate-validation-records.sh staging

# For development
./infrastructure/scripts/get-certificate-validation-records.sh development
```

### 3. Adding Records to GoDaddy

The validation records are CNAME records that look like:

-   **Type**: CNAME
-   **Name**: `_<random-string>.<subdomain>`
-   **Value**: `_<random-string>.acm-validations.aws.`
-   **TTL**: 600 (10 minutes)

#### Steps for GoDaddy:

1. Log in to your GoDaddy account
2. Navigate to **My Products** > **Domains** > **DNS**
3. Click **Add** to create a new record
4. Select **CNAME** as the record type
5. For the **Name** field:
    - Remove the `.hyperchonk.com.` suffix from the AWS-provided name
    - Example: If AWS gives `_abc123.api.hyperchonk.com.`, enter `_abc123.api`
6. For the **Value** field:
    - Enter the full value provided by AWS
    - Example: `_xyz789.acm-validations.aws.`
7. Set **TTL** to 600 seconds
8. Click **Save**

### 4. Validation Timeline

-   DNS propagation typically takes 5-30 minutes
-   Certificate validation may take up to 30 minutes after DNS propagation
-   The certificate status will change from "Pending Validation" to "Issued"

## Infrastructure Flow

```
1. HostedZoneStack (creates Route53 hosted zone)
   ↓
2. CertificateStack (creates ACM certificate with DNS validation)
   ↓
3. Manual Step: Add DNS validation records to GoDaddy
   ↓
4. ACM validates domain ownership
   ↓
5. ComputeStack (uses the validated certificate for HTTPS)
```

## Troubleshooting

### Certificate Stuck in "Pending Validation"

-   Verify DNS records are correctly added in GoDaddy
-   Check DNS propagation: `dig _<validation-string>.<domain> CNAME`
-   Ensure no typos in the record name or value
-   Wait at least 30 minutes for validation

### Wrong Domain in Certificate

-   Check the environment configuration files
-   Ensure `domainName` in the config matches your intended domain
-   Redeploy the CertificateStack if changes are needed

### DNS Records Not Showing

-   Run the validation records script with the correct environment
-   Ensure the certificate exists: `aws acm list-certificates`
-   Check AWS region (should be us-east-1)

## Important Notes

1. **One-Time Setup**: DNS validation records only need to be added once per certificate
2. **Auto-Renewal**: Once validated, ACM automatically renews certificates
3. **Multiple Environments**: Each environment needs its own certificate and validation
4. **Route53 Integration**: While we use Route53 for the hosted zone, the actual DNS is managed in GoDaddy

## Related Files

-   **Certificate Stack**: `/infrastructure/lib/stacks/certificate-stack.ts`
-   **Hosted Zone Stack**: `/infrastructure/lib/stacks/hosted-zone-stack.ts`
-   **Environment Configs**: `/infrastructure/config/environments/*.ts`
-   **Validation Script**: `/infrastructure/scripts/get-certificate-validation-records.sh`

## AWS CLI Commands

```bash
# List all certificates
aws acm list-certificates

# Get certificate details (replace ARN)
aws acm describe-certificate --certificate-arn arn:aws:acm:us-east-1:123456789:certificate/abc-def-ghi

# Check certificate status
aws acm list-certificates --query "CertificateSummaryList[?DomainName=='api.hyperchonk.com']"
```
