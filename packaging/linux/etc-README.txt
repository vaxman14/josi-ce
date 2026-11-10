Josi server settings

  runtime.json  link to /var/lib/josi/data/config/runtime.json: the ports and
                version Josi's services use. The installer owns it.
  update.json   where the web updater looks for new releases:
                  {"feed": "https://.../linux-latest.json", "allowHttp": false}

Start, stop and status:  systemctl start|stop|status josi
Logs:                    journalctl -u 'josi-ce-*'
Data:                    /var/lib/josi (kept on uninstall)
Remove:                  sudo josi-uninstall            (keeps the data)
                         sudo josi-uninstall --purge    (deletes it too)
