import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import https from 'https';

export interface SFMCConfig {
    clientId: string;
    clientSecret: string;
    authBaseUri: string;
    restBaseUri: string;
    soapBaseUri?: string;
    defaultAccountId?: string;
}

interface TokenCache {
    accessToken: string;
    expiration: Date;
    restBaseUri: string;
    soapBaseUri: string;
}

export class SFMCClient {
    private config: SFMCConfig;
    private http: AxiosInstance;
    // Token cache keyed by account/mid ID (or 'default' for no MID)
    private tokenCache: Map<string, TokenCache> = new Map();

    constructor(config: SFMCConfig) {
        this.config = config;
        this.http = axios.create({
            httpsAgent: new https.Agent({ rejectUnauthorized: true }),
        });
    }

    /**
     * Get (or refresh) an access token for a specific MID.
     * If mid is omitted, uses the default account from config.
     */
    async getToken(mid?: string): Promise<TokenCache> {
        const cacheKey = mid ?? this.config.defaultAccountId ?? 'default';
        const cached = this.tokenCache.get(cacheKey);
        if (cached && cached.expiration > new Date()) {
            return cached;
        }

        const body: Record<string, string> = {
            grant_type: 'client_credentials',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
        };

        const effectiveMid = mid ?? this.config.defaultAccountId;
        if (effectiveMid) {
            body.account_id = effectiveMid;
        }

        const response = await this.http.post(
            `${this.config.authBaseUri}/v2/token`,
            body,
            { headers: { 'Content-Type': 'application/json' } }
        );

        const expiresIn: number = response.data.expires_in || 1140;
        const restBase: string = response.data.rest_instance_url || this.config.restBaseUri;
        const rawSoapBase: string =
            this.config.soapBaseUri ||
            response.data.soap_instance_url ||
            this.config.authBaseUri.replace('.auth.', '.soap.').replace(/\/$/, '');
        const soapBase: string = rawSoapBase.endsWith('/Service.asmx')
            ? rawSoapBase
            : rawSoapBase.replace(/\/$/, '') + '/Service.asmx';

        const entry: TokenCache = {
            accessToken: response.data.access_token,
            expiration: new Date(Date.now() + (expiresIn - 60) * 1000),
            restBaseUri: restBase.endsWith('/') ? restBase : restBase + '/',
            soapBaseUri: soapBase,
        };

        this.tokenCache.set(cacheKey, entry);
        return entry;
    }

    /**
     * Make a REST API request. Optionally pass `mid` to target a specific BU.
     */
    async rest<T = any>(
        method: string,
        endpoint: string,
        options: { data?: any; params?: Record<string, any>; mid?: string } = {}
    ): Promise<T> {
        const token = await this.getToken(options.mid);
        const url = endpoint.startsWith('http')
            ? endpoint
            : `${token.restBaseUri}${endpoint.replace(/^\//, '')}`;

        const config: AxiosRequestConfig = {
            method: method.toLowerCase(),
            url,
            headers: {
                Authorization: `Bearer ${token.accessToken}`,
                'Content-Type': 'application/json',
            },
            params: options.params,
        };

        if (options.data && ['post', 'put', 'patch'].includes(method.toLowerCase())) {
            config.data = options.data;
        }

        try {
            const res = await this.http.request<T>(config);
            return res.data;
        } catch (err: any) {
            if (err.response) {
                throw new Error(`SFMC REST error (${err.response.status}): ${JSON.stringify(err.response.data)}`);
            }
            throw new Error(`SFMC REST request failed: ${err.message}`);
        }
    }

    /**
     * Make a SOAP API request. Optionally pass `mid` to target a specific BU.
     */
    async soap(action: string, body: string, mid?: string): Promise<string> {
        const token = await this.getToken(mid);

        const accountId = mid || this.config.defaultAccountId;
        const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
    <s:Header>
        <a:Action s:mustUnderstand="1">${action}</a:Action>
        <a:To s:mustUnderstand="1">${token.soapBaseUri}</a:To>
        <fueloauth xmlns="http://exacttarget.com">${token.accessToken}</fueloauth>
        ${accountId ? `<AccountId xmlns="http://exacttarget.com">${accountId}</AccountId>` : ''}
    </s:Header>
    <s:Body>
        ${body}
    </s:Body>
</s:Envelope>`;

        try {
            const res = await this.http.post(token.soapBaseUri, envelope, {
                headers: {
                    'Content-Type': 'text/xml',
                    SOAPAction: action,
                },
                responseType: 'text',
            });
            return res.data as string;
        } catch (err: any) {
            if (err.response) {
                throw new Error(`SFMC SOAP error (${err.response.status}): ${err.response.data}`);
            }
            throw new Error(`SFMC SOAP request failed: ${err.message}`);
        }
    }
}
