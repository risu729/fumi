// Build-generated trusted synthetic bytes; ephemeral keys and PDF attachments stay ignored.
import raw from "../../.cloudflare/attachment-fixture.json?raw";
const fixture = JSON.parse(raw) as {
  password: string;
  encryptedPdf: string;
  overPageLimitPdf: string;
};
export const encryptedPdf = fixture.encryptedPdf;
export const overPageLimitPdf = fixture.overPageLimitPdf;
export const syntheticPdfPassword = fixture.password;
