# Provenance

This is a portable extraction of a read-only API client and safe error handling developed while adapting [rickygarim/fitbit-google-health-mcp](https://github.com/rickygarim/fitbit-google-health-mcp), adopted at ebb0ea599241d21a320fbce44cc5ec6faa17f16c under MIT. Original upstream author Rithvik Garimella remains credited and the license notice is preserved. The hosted adapter, read-only transport checks, bounded response handling and additional synthetic regression cases were developed by Kian Konrad Tajbakhsh with coding-agent assistance.

This is not an official Google, Fitbit or upstream-maintainer product. No upstream engine, OAuth application, Site deployment, authentication broker, account configuration or real health records are distributed. Tests construct fake responses/tokens and perform no real provider calls. Google data/services and trademarks retain their own terms.

The combined template retains upstream metric analytics and the 17 read-only tool interface, with an injectable MCP server factory, shared improved HTTP client and a separate generic local OAuth helper. No personal hosted application, credential broker, account details or health records were copied. The former standalone client repository is private and superseded by this combined public template.
