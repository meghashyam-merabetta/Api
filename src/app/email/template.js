export function otpEmail(code, expiresIn = 300) {
  if (!/^\d{6}$/.test(code)) throw new Error('Invalid OTP format');
  const minutes = Math.ceil(expiresIn / 60);
  const text = `MeraBetta — Login Verification Code\n\nYour verification code is ${code}. This code is valid for ${minutes} minutes.\n\nNever share this verification code with anyone. MeraBetta will never ask for your OTP by phone, email or message. If you did not request this code, you can safely ignore this email.\n\nRegards,\nMeraBetta Security Team\nThis is an automated security email. Please do not reply.`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Login Verification Code</title></head>
<body style="margin:0;padding:0;background:#f6f0fa;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
<div style="display:none;max-height:0;overflow:hidden;">Your MeraBetta login code is valid for ${minutes} minutes.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f0fa;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #e9dfef;border-radius:20px;overflow:hidden;">
<tr><td height="6" bgcolor="#8752a1" style="height:6px;font-size:0;line-height:0;border-radius:20px 20px 0 0;">&nbsp;</td></tr>
<tr><td align="center" bgcolor="#ffffff" style="padding:26px 24px 22px;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:38px;line-height:1.2;font-weight:bold;letter-spacing:-1.5px;"><span style="color:#8752a1;">mera</span><span style="color:#f5803d;">betta</span><span style="font-size:20px;letter-spacing:-0.5px;color:#8752a1;">.com</span></div>
<p style="font-size:11px;line-height:1.6;color:#8752a1;margin:10px 0 0;">Care Beyond Age. Support Beyond Limits.</p>
<p style="font-size:10px;font-weight:bold;letter-spacing:2px;line-height:1.6;color:#8752a1;margin:20px 0 0;">SECURE ACCOUNT VERIFICATION</p></td></tr>
<tr><td height="4" bgcolor="#f5803d" style="height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:30px 24px;">
<p style="font-size:10px;font-weight:bold;letter-spacing:1.5px;color:#8752a1;margin:0 0 12px;">A LITTLE CHECK, AND YOU'RE IN</p>
<h1 style="font-size:25px;line-height:1.3;letter-spacing:-0.5px;color:#1f2937;margin:0 0 14px;">Your secure sign-in code</h1>
<p style="font-size:14px;line-height:1.8;color:#5b6474;margin:0 0 24px;">Welcome to MeraBetta. Enter the code below to sign in and continue caring for yourself and the people you love.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="#f6f0fa" style="padding:24px 10px;border:1px solid #e7d8f2;border-radius:14px;">
<p style="font-size:10px;letter-spacing:1.5px;font-weight:bold;color:#5b6474;margin:0 0 12px;">YOUR VERIFICATION CODE</p>
<div style="font-size:32px;line-height:1.4;font-weight:bold;letter-spacing:6px;color:#8752a1;">${code}</div>
<p style="font-size:12px;line-height:1.7;color:#5b6474;margin:12px 0 0;">Valid for <strong style="color:#a4471b;">${minutes} minutes</strong>. Use it only in MeraBetta.</p></td></tr></table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:24px;"><tr><td bgcolor="#fff5ec" style="padding:18px;border-left:3px solid #f5803d;border-radius:4px;">
<strong style="font-size:12px;color:#a4471b;">Security Notice</strong>
<p style="font-size:12px;line-height:1.8;color:#5b6474;margin:10px 0 0;">Keep this code to yourself. MeraBetta will never ask you to share your OTP by phone, email, or message.</p>
<p style="font-size:12px;line-height:1.8;color:#5b6474;margin:10px 0 0;">Didn't request a code? You can safely ignore this email.</p></td></tr></table>
<p style="font-size:13px;line-height:1.8;color:#5b6474;margin:26px 0 4px;">A little care. A little peace of mind.</p>
<p style="font-size:13px;font-weight:bold;color:#8752a1;margin:0;">The MeraBetta Team</p></td></tr>
<tr><td align="center" bgcolor="#faf7fc" style="padding:22px 24px;border-top:1px solid #e9dfef;border-radius:0 0 20px 20px;">
<p style="font-size:12px;font-weight:bold;color:#8752a1;margin:0 0 8px;">Made for seniors. Here for the whole family.</p>
<p style="font-size:11px;line-height:1.8;color:#5b6474;margin:0;">This is an automated security email. Please do not reply.</p>
<p style="font-size:10px;color:#5b6474;margin:10px 0 0;">&copy; ${new Date().getUTCFullYear()} MeraBetta. All rights reserved.</p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: 'MeraBetta — Login Verification Code', html, text,
  };
}
