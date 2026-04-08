# Configuring Authentik

The roster uses Authentik as its OIDC provider. This page covers the one-time setup needed in your Authentik instance.

## 1. Create an OAuth2/OIDC Application

In the Authentik admin UI:

1. Go to **Applications → Providers → Create**
2. Select **OAuth2/OpenID Provider**
3. Configure the provider:
   - **Name:** `E4E Roster`
   - **Authorization flow:** your standard authorization flow (e.g. `default-provider-authorization-implicit-consent`)
   - **Client type:** `Confidential`
   - **Redirect URIs:**
     - `http://localhost:3000/auth/callback` (local dev)
     - `https://roster.example.com/auth/callback` (production)
   - **Scopes:** `openid`, `profile`, `email` — and add a scope that exposes group membership (see step 3)
4. Save and copy the **Client ID** and **Client Secret** into your `.env`

Then go to **Applications → Create**, link it to the provider you just created.

## 2. Find the Issuer URL

The `OIDC_ISSUER_URL` is the OpenID Configuration discovery endpoint for your application. Find it in:

**Applications → \<your app\> → Provider → OpenID Configuration URL**

It will look like:
```
https://auth.example.com/application/o/e4e-roster/
```

Set this as `OIDC_ISSUER_URL` in `.env`.

## 3. Expose Group Membership in the Token

The roster reads a `groups` claim from the userinfo endpoint to determine admin access. Configure this in Authentik:

1. Go to **Customization → Property Mappings → Create**
2. Select **Scope Mapping**
3. Configure:
   - **Name:** `E4E Groups`
   - **Scope name:** `groups`
   - **Expression:**
     ```python
     return {
         "groups": [g.name for g in request.user.ak_groups.all()]
     }
     ```
4. Go back to your OAuth2 Provider → edit it → add the `E4E Groups` scope mapping under **Advanced Protocol Settings → Scopes**

The group name set in `ADMIN_GROUP` (default: `e4e-admin`) must match a group name in Authentik/LDAP exactly.

## 4. Verify the Setup

Start the backend (`npm run dev`) and navigate to http://localhost:3000. You should be redirected to Authentik to sign in, then back to the dashboard on success.

If login fails, check:
- The redirect URI in Authentik matches `OIDC_REDIRECT_URI` in `.env` exactly
- The `OIDC_ISSUER_URL` ends with a `/` and the discovery endpoint (`<OIDC_ISSUER_URL>.well-known/openid-configuration`) is reachable from the backend
