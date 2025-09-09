import base64 as b64
import gzip
import json
import os
import urllib3
import boto3
import re
from typing import Dict, Any, List

http = urllib3.PoolManager()
secrets_client = boto3.client('secretsmanager')
cached_secrets = None

def get_secrets(secret_arn: str) -> dict:
    """Fetch and cache secrets."""
    global cached_secrets
    if cached_secrets:
        return cached_secrets
    try:
        response = secrets_client.get_secret_value(SecretId=secret_arn)
        cached_secrets = json.loads(response['SecretString'])
        return cached_secrets
    except Exception as e:
        print(f"Error fetching secrets: {str(e)}")
        return {}

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Forward CloudWatch logs to Grafana Cloud Loki with enhanced parsing"""
    try:
        # Decode CloudWatch logs data
        cw_logs = event['awslogs']['data']
        cw_logs = gzip.decompress(b64.b64decode(cw_logs))
        log_events = json.loads(cw_logs)
        
        if not log_events.get('logEvents'):
            print("No log events to process")
            return {
                'statusCode': 200,
                'body': 'No log events to process'
            }
        
        print(f"Processing {len(log_events['logEvents'])} log events from {log_events['logGroup']}")
        
        # Transform logs for Loki format
        streams = []
        for log_event in log_events['logEvents']:
            # Parse timestamp to nanoseconds (CloudWatch timestamps are in milliseconds)
            timestamp_ns = str(log_event['timestamp'] * 1000000)
            
            # Base labels for Grafana Cloud
            labels = {
                'service': 'balancer-v3-backend',
                'environment': os.environ['ENVIRONMENT'],
                'log_group': log_events['logGroup'],
                'log_stream': log_events['logStream'],
                'source': 'aws-cloudwatch'
            }
            
            message = log_event['message'].strip()
            print(f"Processing message: {message[:100]}{'...' if len(message) > 100 else ''}")
            
            # Try to parse structured JSON logs first (from our simple-logging.ts)
            if message.startswith('{') and message.endswith('}'):
                try:
                    parsed = json.loads(message)
                    print(f"Successfully parsed JSON log: {list(parsed.keys())}")
                    # Extract structured fields as labels
                    for field in ['level', 'job', 'chain', 'phase', 'sync_job']:
                        if field in parsed and parsed[field]:
                            labels[field] = str(parsed[field])
                    
                    # Extract duration as a separate field
                    if 'duration' in parsed and parsed['duration']:
                        labels['has_duration'] = 'true'
                        
                except json.JSONDecodeError as e:
                    print(f"Failed to parse JSON log: {str(e)}")
            else:
                # Parse timestamped logs like [2025-06-11T06:19:43.354Z] [INFO] message
                timestamp_match = re.search(r'\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*\[([^\]]+)\]', message)
                if timestamp_match:
                    extracted_level = timestamp_match.group(2).lower()
                    labels['level'] = extracted_level
                    print(f"Extracted level from timestamp format: {extracted_level}")
                else:
                    # Parse existing console.log patterns for sync jobs (FIXED REGEX)
                    if 'job' in message and '-' in message:
                        # Extract job info from patterns like "Start job sync-pools-POLYGON-start"
                        job_match = re.search(r'(?:Start job|Successful job|Error job|Skip job)\s+([^\s-]+)-([^\s-]+)', message)
                        if job_match:
                            labels['sync_job'] = job_match.group(1)
                            labels['chain'] = job_match.group(2)
                            print(f"Extracted job info: {labels['sync_job']}-{labels['chain']}")
                            
                            if 'Start job' in message:
                                labels['phase'] = 'start'
                            elif 'Successful job' in message:
                                labels['phase'] = 'complete'
                            elif 'Error job' in message:
                                labels['phase'] = 'failed'
                            elif 'Skip job' in message:
                                labels['phase'] = 'skip'
                    
                    # Determine log level from message content if not already set
                    if 'level' not in labels:
                        if 'error' in message.lower() or 'failed' in message.lower():
                            labels['level'] = 'error'
                        elif 'warn' in message.lower():
                            labels['level'] = 'warn'
                        else:
                            labels['level'] = 'info'
            
            streams.append({
                'stream': labels,
                'values': [[timestamp_ns, message]]
            })
        
        # Send to Grafana Cloud Loki
        loki_payload = {'streams': streams}
        
        # Get credentials from Secrets Manager at runtime
        secret_arn = os.environ.get('SECRET_ARN')
        if not secret_arn:
            print("ERROR: SECRET_ARN environment variable not set")
            return {
                'statusCode': 500,
                'body': 'SECRET_ARN environment variable not configured'
            }
        
        secrets = get_secrets(secret_arn)

        user_id_key = os.environ.get('GRAFANA_CLOUD_USER_ID_KEY')
        api_key_key = os.environ.get('GRAFANA_CLOUD_API_KEY_KEY')
        loki_endpoint_key = os.environ.get('GRAFANA_CLOUD_LOKI_ENDPOINT_KEY')

        user_id = secrets.get(user_id_key) if user_id_key else None
        api_key = secrets.get(api_key_key) if api_key_key else None
        loki_endpoint = secrets.get(loki_endpoint_key) if loki_endpoint_key else None
        
        if not user_id or not api_key:
            print(f"WARNING: Missing credentials - USER_ID: {'✓' if user_id else '✗'}, API_KEY: {'✓' if api_key else '✗'}")
            return {
                'statusCode': 200,
                'body': 'Grafana Cloud credentials not configured - skipping log forwarding'
            }
            
        if not loki_endpoint:
            print("WARNING: GRAFANA_CLOUD_LOKI_ENDPOINT not set - using default")
            loki_endpoint = 'https://logs-prod-us-central1.grafana.net/loki/api/v1/push'
        
        # Create basic auth credentials (user_id:api_key)
        credentials = b64.b64encode(f'{user_id}:{api_key}'.encode()).decode()
        
        print(f"Sending {len(streams)} streams to Grafana Cloud: {loki_endpoint}")
        
        response = http.request(
            'POST',
            loki_endpoint,
            body=json.dumps(loki_payload).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Basic {credentials}'
            }
        )
        
        if response.status >= 400:
            error_body = response.data.decode() if response.data else 'No response body'
            print(f"Error forwarding to Grafana Cloud: {response.status} {error_body}")
            return {
                'statusCode': 500,
                'body': f'Grafana Cloud returned {response.status}: {error_body}'
            }
        
        print(f"Successfully forwarded {len(streams)} log entries to Grafana Cloud")
        return {
            'statusCode': 200,
            'body': f'Successfully forwarded {len(streams)} log entries to Grafana Cloud'
        }
        
    except Exception as e:
        print(f'Error forwarding logs to Grafana Cloud: {str(e)}')
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'body': f'Error: {str(e)}'
        } 
