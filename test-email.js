const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: 'dhanushgovinthang@gmail.com', pass: 'qgcqmqmbzmivjlwa' }
});

const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>BARM AI</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <tr>
        <td style="background:linear-gradient(135deg,#6D5EF8 0%,#8B5CF6 100%);padding:28px 32px;">
          <p style="margin:0;color:#ffffff;font-size:22px;font-weight:800;">BARM AI Dashboard</p>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">Test Email</p>
        </td>
      </tr>
      <tr>
        <td style="padding:32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <table cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;">
                  <tr><td align="center" style="padding:24px 40px;">
                    <p style="margin:0;font-size:40px;line-height:1;">&#9989;</p>
                    <h2 style="margin:12px 0 6px;color:#166534;font-size:20px;font-weight:800;">Email Connected!</h2>
                    <p style="margin:0;color:#15803d;font-size:14px;font-weight:600;">Your BARM AI alerts are now active.</p>
                  </td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td>
                <table width="100%" cellpadding="12" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;">
                  <tr>
                    <td style="color:#6b7280;font-size:13px;font-weight:700;border-bottom:1px solid #f0f0f0;">FROM</td>
                    <td style="color:#111;font-size:13px;font-weight:800;border-bottom:1px solid #f0f0f0;">dhanushgovinthang@gmail.com</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;font-weight:700;">TO</td>
                    <td style="color:#111;font-size:13px;font-weight:800;">dhanushgovinthang@gmail.com</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-top:24px;">
                <a href="http://localhost:3000/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px;border-top:1px solid #f0f0f0;text-align:center;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by BARM AI Dashboard</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;

transporter.sendMail({
  from: 'BARM AI Dashboard <dhanushgovinthang@gmail.com>',
  to: 'dhanushgovinthang@gmail.com',
  subject: 'BARM AI - Email Connected Successfully!',
  html: html
}, (err, info) => {
  if(err) console.log('ERROR:', JSON.stringify(err, null, 2));
  else console.log('SUCCESS - MessageID:', info.messageId);
});
