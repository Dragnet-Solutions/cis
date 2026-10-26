The CIS-Dragnet Benchmark Study: landing page
State of Stockbroking Operations and Investor Experience in Nigeria: A 2026 CIS-Dragnet Study
Address: https://cisdragnetstudy.com
=====================================================================

This is a plain static website: HTML, CSS, images and fonts only.
No build step, no database, no PHP, no Node, nothing to install.
It loads nothing from other websites.


WHAT IS IN THIS ZIP
-------------------
  cisdragnetstudy/       The website. Upload everything inside this folder.
  server-config/         Ready-made server settings (nginx or Apache).
  README.txt             This file.


STEP 1. Upload the website
--------------------------
Copy everything INSIDE the "cisdragnetstudy" folder to the web root,
for example /var/www/cisdragnetstudy

After copying, index.html must sit directly in the web root:
  /var/www/cisdragnetstudy/index.html
  /var/www/cisdragnetstudy/privacy.html
  /var/www/cisdragnetstudy/404.html
  /var/www/cisdragnetstudy/robots.txt   (and the other .txt/.xml files)
  /var/www/cisdragnetstudy/assets/...


STEP 2. HTTPS certificate
-------------------------
Get a certificate for cisdragnetstudy.com and www.cisdragnetstudy.com,
for example:
  sudo certbot certonly --nginx -d cisdragnetstudy.com -d www.cisdragnetstudy.com
DNS for both names must point to this server first.


STEP 3. Server settings
-----------------------
nginx (recommended):
  1. Copy server-config/nginx-cisdragnetstudy.conf to /etc/nginx/sites-available/
  2. Link it:  sudo ln -s /etc/nginx/sites-available/nginx-cisdragnetstudy.conf /etc/nginx/sites-enabled/
  3. If your certificate or web root is in a different place, change those paths in the file.
  4. Test and reload:  sudo nginx -t && sudo systemctl reload nginx

Apache (only if the server is Apache):
  Rename server-config/apache-htaccess.txt to .htaccess and put it next to index.html.
  Needs mod_rewrite, mod_headers and mod_expires switched on.


STEP 4. Platform links are switched off  (IMPORTANT)
----------------------------------------------------
This version is a marketing information page only. It does not link
to the survey platform. The survey and sign-in buttons are hidden in
the HTML (inside comments), and the /survey and /firm forwarding lines
in the server config are switched off with "#".

Do NOT switch them back on until the Product Owner says the platform
is live and gives you the real addresses. Then:
  1. In the server config, remove the "#" from the two lines under
     "PLATFORM LINKS" and put in the real addresses.
  2. The Product Owner will give you updated HTML with the buttons restored.


STEP 5. Check it works
----------------------
  [ ] https://cisdragnetstudy.com opens the page, padlock shows
  [ ] http://cisdragnetstudy.com and https://www.cisdragnetstudy.com
      both forward to https://cisdragnetstudy.com
  [ ] Both logos and the fonts show (headings are heavy and black)
  [ ] "How your information is handled" in the footer opens the privacy page
  [ ] https://cisdragnetstudy.com/anything-wrong shows the "Page not found" page
  [ ] https://cisdragnetstudy.com/survey and /firm show "Page not found" (expected for now)
  [ ] https://cisdragnetstudy.com/robots.txt, /sitemap.xml and /llms.txt open
  [ ] Security headers: check at https://securityheaders.com (should be A or A+)

After it is live, the Product Owner may submit
https://cisdragnetstudy.com/sitemap.xml in Google Search Console and
Bing Webmaster Tools.


Help: support@cisdragnetstudy.com
