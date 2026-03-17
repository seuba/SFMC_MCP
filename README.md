# SFMC MCP Server Tool

Overview        
                                                                                                               
  The SFMC MCP Server is a Model Context Protocol (MCP) integration that connects Claude Code to your
  Salesforce Marketing Cloud instance.


## Features

  - Data Extensions — list, query, and count records in any DE across any Business Unit
  - CloudPages — list and read the full source code of any CloudPage or Form Handler
  - Journeys — list and inspect Journey Builder journeys
  - Emails — list and retrieve email assets
  - Automations — list automations across BUs
  - Subscribers — look up subscriber data
  - Send Definitions — list transactional send definitions
  - Lists — retrieve subscriber lists
  - Business Units — list all BUs in your enterprise
  - REST API — make arbitrary REST API calls to any SFMC endpoint
  - SOAP API — make arbitrary SOAP API calls (create DEs, upsert rows, manage assets, etc.)

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/seuba/SFMC_MCP.git
   cd SFMC_MCP
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

You'll need to configure the tool with your SFMC credentials. The tool expects the following environment variables:

- `SFMC_CLIENT_ID`: Your SFMC API client ID
- `SFMC_CLIENT_SECRET`: Your SFMC API client secret
- `SFMC_AUTH_BASE_URI`: The authentication base URI (e.g., `https://auth.example.salesforce.com`)
- `SFMC_REST_BASE_URI`: The REST API base URI (e.g., `https://rest.example.salesforce.com`)
- `SFMC_SOAP_BASE_URI`: The REST API base URI (e.g., `https://SOAP.example.salesforce.com`)
- `SFMC_ACCOUNT_ID`: Your SFMC account ID


## Claude Configuration

To use this tool with Claude:

1. Create a new MCP configuration in Claude Desktop
2. Use the following configuration template (adjust paths):

```json
{
  "name": "SFMCmcp",
  "command": "node /path/to/SFMC_MCP/build/index.js",
  "env": {
    "SFMC_CLIENT_ID": "your_client_id",
    "SFMC_CLIENT_SECRET": "your_client_secret",
    "SFMC_AUTH_BASE_URI": "https://auth.example.salesforce.com",
    "SFMC_REST_BASE_URI": "https://rest.example.salesforce.com",
    "SFMC_REST_BASE_URI": "https://rest.example.salesforce.com",
    "SFMC_ACCOUNT_ID": "your_account_id_if_needed"
  }
}
```

## Usage Examples


  "How many records are in xxx data extension"
  "Show me the code for xxx CloudPage"
  "Create a data extension called 'example' with an email field"
  "Add a row with email example@example.com to the example DE"
  "List all journeys in BU xxx"
  "What automations do I have?"
  "Create an email called test"

`Disclaimer: The author cannot be held responsible for any damage, data loss, or unintended consequences resulting from the use or misuse of this tool. `

