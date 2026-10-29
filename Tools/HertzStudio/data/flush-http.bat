net stop http /y > C:\Users\Kingsley\HERTZ\Tools\HertzStudio\data\http-svc.log 2>&1
net start http >> C:\Users\Kingsley\HERTZ\Tools\HertzStudio\data\http-svc.log 2>&1
netstat -ano | findstr ":8791" >> C:\Users\Kingsley\HERTZ\Tools\HertzStudio\data\http-svc.log
