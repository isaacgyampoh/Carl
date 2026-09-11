# Signing the Windows installer

The installer is unsigned today. Every client sees "Windows protected your PC" on first run and
has to click through it, and automatic updates stay switched off because an unsigned update
channel is a way to install anything on a shop's till.

The build already signs the moment a certificate exists. Nothing in the application changes.

## What to buy

An **Authenticode code-signing certificate** for the legal entity that publishes Carl. Two kinds:

| Kind                        | What it does to SmartScreen                                              | Notes                                                                     |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| OV (organisation validated) | Warning stops once the certificate builds reputation over some downloads | Cheapest; a new certificate still warns at first                          |
| EV (extended validation)    | Trusted immediately, no reputation period                                | Dearer; the key must live on approved hardware or a cloud signing service |

Cloud signing services (for example Azure Trusted Signing, or a certificate authority's own
signing service) avoid posting a USB token around and work well from CI. Whichever you choose,
you need the certificate as a **`.pfx` file and its password**, or the service's credentials.

Carl is published by whoever owns the company; the certificate must be issued to that name,
because it is the name Windows shows the shopkeeper.

## What to do once you have it

1. Base64-encode the certificate, without newlines:
   - macOS/Linux: `base64 -i certificate.pfx | tr -d '\n' > certificate.b64`
   - Windows: `certutil -encode certificate.pfx certificate.b64` (then remove the header lines)
2. Add two repository secrets in GitHub → Settings → Secrets and variables → Actions:
   - `WINDOWS_CERTIFICATE` — the contents of `certificate.b64`
   - `WINDOWS_CERTIFICATE_PASSWORD` — the password for the `.pfx`
3. Push a version tag (`git tag v0.2.1 && git push origin v0.2.1`).

The release workflow reports its signing status in the job log: "certificate present" means the
installer that release publishes is signed.

## How to check the result

On a Windows machine:

```powershell
Get-AuthenticodeSignature .\Carl-POS-Windows-x64-Setup.exe | Format-List Status, SignerCertificate
```

`Status` must be `Valid`, and the certificate's subject must be your company. Then run the
installer on a machine that has never seen Carl: an OV certificate may still warn until it has
reputation; an EV certificate should not warn at all.

## After signing works

- Turn automatic updates on (`docs/WINDOWS_POS_DEPLOYMENT.md` → Updating). The updater verifies
  the signature, which is what makes an update channel safe to leave running.
- Update the acceptance checklist: step 3 should no longer expect a SmartScreen warning.
- Keep the certificate and its password out of the repository. Both live in GitHub secrets, and
  a copy belongs wherever your company keeps its other credentials.
