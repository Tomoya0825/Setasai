const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const crypto = require('crypto');
const log4js = require('log4js');
const http = require('http');
const https = require('https');
const helmet = require('helmet');
const fs = require('fs');

const app = express();

//設定やQR定義は起動時に定数として扱うので変更時は再起動する。
const serverconf = JSON.parse(fs.readFileSync("./config/server.json", {encoding: 'utf8'}));
const qrconf = JSON.parse(fs.readFileSync("./config/qr.json", {encoding: 'utf8'}));
const giftconf = JSON.parse(fs.readFileSync("./config/gift.json", {encoding: 'utf8'}));
const suggestconf = JSON.parse(fs.readFileSync("./config/suggest.json", {encoding: 'utf8'}));


const connection = mysql.createConnection({
    host: serverconf['mysql']['host'],
    user: serverconf['mysql']['user'],
    password: serverconf['mysql']['password'],
    port: serverconf['mysql']['port'],
    database: serverconf['mysql']['database'],
});
const table = serverconf['mysql']['table'];

log4js.configure({
    appenders:{
        server:{type:'file', filename: './log/server.log'},
        fatal:{type:'fileSync', filename: './log/server.log'},
        console:{type:'console'}
    },
    categories:{
        default:{appenders:['server', 'fatal', 'console'], level: 'ALL'}
    }
});
const logger = log4js.getLogger('server');
const f_loger = log4js.getLogger('fatal');

//app.use(bodyParser.urlencoded({ extended: true })); //url-encoded
app.use(bodyParser.json()); //json
app.use(express.static('./webpage'));
app.use(helmet());
//Expressパース時エラー処理
app.use(function(err,req,res,next){
    let sfunc = req['originalUrl'].slice(req['originalUrl'].lastIndexOf('/')+1);
    try{
        if(err){
            if(err['type']=='entity.parse.failed'){
                //JSONじゃないのなげきたやばいばあい(こうげきされてる)
                logger.warn(`(${sfunc}) Bad Request`);
                res.status(400).json({"result":"bad request"});
            }else{
                //不明エラー時
                logger.error(err);
                res.status(500).json({"result":"unknown error"});
            }
        }
    }catch(ex){
        //不明エラー時
        res.status(500).json({"result":"unknown error"});;
        logger.error(ex);
    }
});

//ufwで 443ポート開放済み (実行にroot権限必須)
https.createServer({
    key: fs.readFileSync(serverconf['certificate_file']['key']),
    cert: fs.readFileSync(serverconf['certificate_file']['cert']),
    ca: fs.readFileSync(serverconf['certificate_file']['ca'])
},app).listen(443);
//httpリダイレクト用。
const exhttp = express();
http.createServer(exhttp.all('*', (req, res)=>{
    res.redirect(301, `https://${req['hostname']}${req['url']}`);
})).listen(80);



/*  ログ漏れないか確認
error   サーバ処理エラー 基本500返す
warn    へんなリクエスト投げられたとき 基本400返す
indo    SQLの履歴
*/


//auth_code生成用 I i l 1 O o 0 J j は見ずらいかもしんないので使わない
const S1 = "abcdefghkmnpqrstuvwxyz23456789";
const S2 = "123456789"

//#####ユーザ登録API#####
//必要なパラメータはナシ
//idとauth_codeを返す
//その他必要な条件はナシ
app.post('/API/Entry', (req, res)=>{
    let user_agent = 'Unknown';
    if(req.header('User-Agent')){
        user_agent = req.header('User-Agent');
    }
    if(user_agent.length>200){
        user_agent = 'Unknown(Too Long UA)';
    }
    let auth_code1 = Array.from(crypto.randomFillSync(new Uint8Array(6))).map((n) => S1[n % S1.length]).join('');
    let auth_code2 = Array.from(crypto.randomFillSync(new Uint8Array(6))).map((n) => S2[n % S2.length]).join('');

    sbegin().then(()=>{
        return squery("INSERT INTO ??(auth_code, user_agent, os, created_at, data, gift, suggest) VALUES (?,?,?,?,?,?,?);",
        [table, `${auth_code1}-${auth_code2}`, `${user_agent}`, `${getos(user_agent)}`, now(), '[]', '[]', '未分類']);
    }).then(()=>{
        return squery("SELECT id, auth_code FROM ?? WHERE id=LAST_INSERT_ID();", [table]);
    }).then(results=>{
        res.status(200).json({
            'id': `${results['id']}`,
            'auth_code': `${results['auth_code']}`
        });
        return scommit();
    }).catch(ex=>{
        srollback().then(()=>{
            res.status(500).json({"error": "server error"});
            logger.error(ex);
        });
    });
});

//#####QR読み取り記録API#####
//idとauth_codeと読み取ったqrが必要 (qrは「tcu_Ichigokan」など)
//固有ページのURLを返す (「https://page.com/enquete?location=一号館」など)  @@@@@景品交換所の場合は別処理@@@@@
//idとauth_codeで認証できqrが定義されているものであることが必須、記録済みで回答済みの場合はURLを返さない。(記録のみの時はURL返す)
app.post('/API/RecordQR', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let qr = objsearch(qrconf, "qr", req.body['qr'], "qr"); //送られてきたQRと定義を照らし合わせる。(変なリクエスト対策)

    if(objsearch(qrconf, "qr", qr, "contents_type")=="gift"){    //景品交換所
        res.status(200).json({"url": `https://${req['hostname']}/gift`});
    }else{
        new Promise((resolve, reject)=>{
            if(!id || !auth_code || !qr){
                res.status(400).json({"error": "invalid parameter"});
                logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, qr: ${qr}`);
                reject(new Error("req error(Still Begin)"));
            }else{
                resolve();
            }
        }).then(()=>{
            return sbegin();
        }).then(()=>{
            //認証　該当なければ Error('not found')帰ってくるのでcatchで処理
            return squery("SELECT data FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]);
        }).then(result=>{ //resultはユーザデータの配列。要素はJSON (文字列なのでparseしないと使えない) "[{},{}]"
            let userdata = JSON.parse(result);
            if(objsearch(userdata, "qr", qr)){  //既にQR登録済みかどうか
                if(objsearch(userdata, "qr", qr, "point")>0){  //QR登録済みの場合回答済みか(ポイントで判別)
                    res.status(400).json({"error": "alrady recorded"});
                }else{
                    res.status(200).json({"url": `https://${req['hostname']}/${objsearch(qrconf, "qr", qr, "contents_type")}?location=${objsearch(qrconf, "qr", qr, "location")}`});
                }
                throw new Error("req error");
            }
            userdata.push({
                qr: qr,
                time: now(),
                point: 0,
                ans: null
            }); //ans: undefined だとansのキー自体が追加されない    [] だとlengthで回答済みかの判断になる
            return squery("UPDATE ?? SET data=? WHERE id=? AND auth_code=?;",[table, JSON.stringify(userdata), id, auth_code])
        }).then(()=>{
            res.status(200).json({"url": `https://${req['hostname']}/${objsearch(qrconf, "qr", qr, "contents_type")}?location=${objsearch(qrconf, "qr", qr, "location")}`});
            scommit();
        }).catch(ex=>{
            if(ex['message']!="req error(Still Begin)"){
                srollback().then(()=>{
                    //リクエストのエラー以外を処理
                    if(ex['message']!="req error"){
                        if(ex['message']=='not found'){
                            //認証エラー時
                            res.status(400).json({"error": "auth faild"});
                            logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
                        }else{
                            res.status(500).json({"error": "server error"});
                            logger.error(ex);
                        }
                    }
                });
            }
        });
    }
});

//#####QR対象固有ページコンテンツ表示API#####
//idとauth_codeとqrのlocationが必要(qrのlocationはクライアント側でURLのクエリから取得)
//固有ページの表示内容を返す。(クライアント側でJSONからHTML作ってInnerHTMLで表示するやつ)
//idとauth_codeで認証でき、ユーザデータにqrのlocationに該当するものが登録済みであり(該当QR記録済み)、回答記録済みでない場合
app.post('/API/UniquePage', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let qr = objsearch(qrconf, "location", req.body['location'], "qr"); //送られてきたlocationと定義を照らし合わせる。(変なリクエスト対策)
    
    new Promise((resolve, reject)=>{
        if(!id || !auth_code || !qr){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, location: ${req.body['location']}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        //認証　該当なければ Error('not found')帰ってくるのでcatchで処理
        return squery("SELECT data FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]);
    }).then(result=>{ //resultはユーザデータの配列。要素はJSON (文字列なのでparseしないと使えない) "[{},{}]"
        let userdata = JSON.parse(result);
        if(!objsearch(userdata, "qr", qr)){  //既に登録済みかどうか
            logger.warn(`[Access Denied] id: ${id}, qr: ${qr}, location: ${req.body['location']}`)
            res.status(400).json({"error":"access denied"});
            throw new Error("req error");
        }else{
            res.status(200).json({"contents": objsearch(qrconf, "qr", qr, "contents")})
        }
    }).catch(ex=>{
        //リクエストのエラー以外を処理
        if(ex['message']!="req error"){
            if(ex['message']=='not found'){
                //認証エラー時
                res.status(400).json({"error": "auth faild"});
                logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
            }else{
                res.status(500).json({"error": "server error"});
                logger.error(ex);
            }
        }
    });
});

//#####QR対象固有ページ回答記録API#####
//idとauth_codeとansとlocationが必要(ansはアンケートの場合json配列、クイズの場合rightかwrong、投票の場合その文字列)
//OKまたはcorrectかwrongを返す  (クイズの場合は正誤確認)
//idとauth_codeで認証でき、ユーザデータにqrのlocationに該当するものが登録済みであり(該当QR記録済み)、回答記録済みでない場合
app.post('/API/RecordAns', (req, res)=>{
    //エスケープする(最初にリクエストをJSON.stringifyしておく)  @@@@@@@@@@クライアント側でもエスケープしないとそもそもおくれない場合あり@@@@@@@@@@
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let ans = req.body['ans'];
    let qr = objsearch(qrconf, "location", req.body['location'], "qr"); //送られてきたlocationと定義を照らし合わせる。(変なリクエスト対策)
    let contents_obj = objsearch(qrconf, "qr", qr, "contents");
    let contents_type = objsearch(qrconf, "qr", qr, "contents_type");
    let savedata="";
    let savepoint=0;

    new Promise((resolve, reject)=>{
        if(!id || !auth_code || !qr || !ans){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, location: ${req.body['location']}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        //認証　該当なければ Error('not found')帰ってくるのでcatchで処理
        return squery("SELECT data FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]);
    }).then(result=>{
        let userdata = JSON.parse(result);
        if(!objsearch(userdata, "qr", qr)){  //既にQR登録済みかどうか
            logger.warn(`[Access Denied] id: ${id}, qr: ${qr}, location: ${req.body['location']}`)
            res.status(400).json({"error":"access denied"});
            return Promise.reject(new Error("req error"));
        }else{
            if(objsearch(userdata, "qr", qr, "point")>0){  //既に回答済みかどうか(ポイントで判断)
                logger.warn(`[Already Answered] id: ${id}, qr: ${qr}, location: ${req.body['location']}`)
                res.status(400).json({"error":"already answered"});
                return Promise.reject(new Error("req error"));
            }else{
                return Promise.resolve(userdata);
            }
        }
    }).then(userdata=>{
        //意図的に定義にない回答を投げられたりしたとき対策やクイズの回答チェックなど
        if(contents_type=="enquete"){
            ans = JSON.parse(JSON.stringify(ans));  //一応のエスケープ
            let enquete_obj = contents_obj['enquete'];
            for(i in enquete_obj){
                if(enquete_obj[i]['type']=="check"){
                    for(j in ans[i]){
                        if(!enquete_obj[i]['choice'].some(value=> value==ans[i][j])){
                            logger.warn(`[Invalid Answer] id: ${id}, ans: ${JSON.stringify(ans)}`);
                            res.status(400).json({"error":"bad request"});
                            throw new Error("req error");
                        }
                    }
                }else if(enquete_obj[i]['type']=="radio"){
                    if(!enquete_obj[i]['choice'].some(value=> value==ans[i])){
                        logger.warn(`[Invalid Answer] id: ${id}, ans: ${JSON.stringify(ans)}`);
                        res.status(400).json({"error":"bad request"});
                        throw new Error("req error");
                    }
                }else if(enquete_obj[i]['type']=="write"){
                    //自由記述なので確認なし(エスケープ済み)
                }
            }
            savedata = JSON.stringify(ans);
            savepoint = objsearch(qrconf, "qr", qr, "point");
        }else if(contents_type=="quiz"){
            if(ans == objsearch(qrconf, "qr", qr, "ans")){
                savedata = "correct"
                savepoint = objsearch(qrconf, "qr", qr, "point_correct");
            }else{
                savedata = "wrong"
                savepoint = objsearch(qrconf, "qr", qr, "point_wrong");
            }
        }else if(contents_type=="vote"){
            if(!contents_obj['choice'].some(value=> value==ans)){
                logger.warn(`[Invalid Answer] id: ${id}, ans: ${ans}`);
                res.status(400).json({"error":"bad request"});
                throw new Error("req error");
            }else{
                savedata = ans;
                savepoint = objsearch(qrconf, "qr", qr, "point");
            }
        }else{
            //ないはず
        }
        let index = userdata.findIndex(value=> value['qr']==qr);
        userdata[index]['ans'] = savedata;
        userdata[index]['point'] = savepoint;
        return squery("UPDATE ?? SET data=? WHERE id=? AND auth_code=?;",[table, JSON.stringify(userdata), id, auth_code]);
    }).then(()=>{
        if(contents_type=="quiz"){
            res.status(200).json({"result": savedata, "point": savepoint});
        }else{
            res.status(200).json({"point": savepoint});
        }
    }).catch(ex=>{
        //リクエストのエラー以外を処理
        if(ex['message']!="req error"){
            if(ex['message']=='not found'){
                //認証エラー時
                res.status(400).json({"error": "auth faild"});
                logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
            }else{
                res.status(500).json({"error": "server error"});
                logger.error(ex);
            }
        }
    })

});

//#####景品交換API#####
//idとauth_codeが必要
//ポイント確認、定義されている景品照らし合わせ、交換済み景品確認、交換済み景品に書き込み
app.post('/API/RecordGift', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let gift = objsearch(giftconf, "name", req.body['gift'], "name");   //定義されているギフトかどうか
    new Promise((resolve, reject)=>{
        if(!id || !auth_code || !gift){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, gift: ${req.body['gift']}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        //認証　該当なければ Error('not found')帰ってくるのでcatchで処理
        return squery("SELECT data, gift FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]);
    }).then(results=>{
        let userdata = JSON.parse(results['data']);
        let sumpoint=0;
        for(i in userdata){
            sumpoint+=userdata[i]['point'];
        }
        if(sumpoint<objsearch(giftconf, "name", gift, "point")){
            res.status(400).json({"error":"insufficient point"});
            throw new Error("req error");
        }
        let usergift = JSON.parse(results['gift']);
        if(usergift.some(value=> value==gift)){
            res.status(400).json({"error":"alrady exchanged"});
            throw new Error("req error");
        }else{
            usergift.push(gift['name']);
            return squery("UPDATE ?? SET gift=? WHERE id=? AND auth_code=?;",[table, JSON.stringify(usergift), id, auth_code]);
        }
    }).then(()=>{
        res.status(200).json({"results": "ok"});
    }).catch(ex=>{
        //リクエストのエラー以外を処理
        if(ex['message']!="req error"){
            if(ex['message']=='not found'){
                //認証エラー時
                res.status(400).json({"error": "auth faild"});
                logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
            }else{
                res.status(500).json({"error": "server error"});
                logger.error(ex);
            }
        }
    });
});

//#####行動履歴によるサジェストAPI#####
//idとauth_codeが必要
//おすすめタイプを都度判断し、SQLに保存し、紹介文とともに返す。(つまりは該当なければ変更しない) 直近で判断。
//idとauth_codeで認証できることが必須
app.post('/API/Suggest', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let suggest={};
    new Promise((resolve, reject)=>{
        if(!id || !auth_code){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        //認証　該当なければ Error('not found')帰ってくるのでcatchで処理
        return squery("SELECT data, gift FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]);
    }).then(results=>{
        let userdata = JSON.parse(results['data']);
        let user_history = userdata.map(value=>{return objsearch(qrconf, "qr", value['qr'], "group")});

        for(i in suggestconf){    
            //jsで配列の比較は直接できないので文字列で(toString()でもOK)
            if(suggestconf[i]['patterns'].some(value=> JSON.stringify(value) == JSON.stringify(user_history.slice(-value.length)))){
                suggest = suggestconf[i];
                return Promise.resolve();   //最初に該当したものを返すように
            }
        }
        return Promise.resolve();   //該当がなかった場合

    }).then(()=>{
        return squery("SELECT suggest FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]);
    }).then(usersgtype=>{
        if(!Object.keys(suggest).length>0){
            if(usersgtype == "未分類"){
                //まだサジェストに一致したことがない
                res.status(200).json({"message": "おすすめはありません"});
            }else{
                //過去に一致したが今回一致しない
                res.status(200).json({"message": objsearch(suggestconf, "type", usersgtype, "message")});
            }
        }else{
            //サジェスト一致
            squery("UPDATE ?? SET suggest=? WHERE id=? AND auth_code=?;",[table, suggest['type'], id, auth_code]).then(()=>{
                res.status(200).json({"message": suggest['message']});
            });
        }
    }).catch(ex=>{
        if(ex['message']!="req error"){
            if(ex['message']=='not found'){
                //認証エラー時
                res.status(400).json({"error": "auth faild"});
                logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
            }else{
                res.status(500).json({"error": "server error"});
                logger.error(ex);
            }
        }
    });


});

//#####ユーザ状態照会API#####
//idとauth_code必要
//ユーザQR読み取り状況、回答状況、現在の合計ポイント、交換可能景品、交換済み景品を返す
//idとauth_codeで認証できることが条件
app.post('/API/GetData', (req, res)=>{
    //こんな感じに返せばよさそう
    let res_sumple ={
        "qr": ["一号館", "二号館"],
        "ans": ["一号館"],
        "point": 600,
        "possible_gift": ["景品B"],
        "exchanged_gift": ["景品A"]
    }

    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    new Promise((resolve, reject)=>{
        if(!id || !auth_code){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        //認証　該当なければ Error('not found')帰ってくるのでcatchで処理
        return squery("SELECT data, gift FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]);
    }).then(results=>{
        let userdata = JSON.parse(results['data']);
        let usergift = JSON.parse(results['gift']);
        let location=[];
        let answerd=[];
        let point=0;
        let possible_gift = [];
        let exchanged_gift = [];
        for(i in userdata){
            location.push(objsearch(qrconf, "qr", userdata[i]['qr'], "location"));
            if(userdata[i]['point']>0){
                point += userdata[i]['point'];
                answerd.push(objsearch(qrconf, "qr", userdata[i]['qr'], "location"))
            }
        }
        possible_gift = giftconf.filter(value=> value['point']<= point);
        squery("SELECT gift FROM ?? WHERE id=? AND auth_code=?;", [table, id, auth_code]).then(usergift=>{
            exchanged_gift = JSON.parse(usergift);
        });
        res.status(200).json({
            "location": location,
            "answerd": answerd,
            "point": point,
            "possible_gift": possible_gift,
            "exchanged_gift": exchanged_gift
        });
    }).catch(ex=>{
        if(ex['message']!="req error"){
            if(ex['message']=='not found'){
                //認証エラー時
                res.status(400).json({"error": "auth faild"});
                logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
            }else{
                res.status(500).json({"error": "server error"});
                logger.error(ex);
            }
        }
    });
});

//#####QRロケーション一覧表示API#####
//必要なパラメータはナシ
//QRのロケーションをすべて返す
//条件ナシ
app.post('/API/GetLocation', (req, res)=>{
    res.status(200).send(JSON.stringify(qrconf.map(values=>values['location'])));
});

//#####景品一覧表示API#####
//必要なパラメータはナシ
//景品をすべて返す
//条件ナシ
app.post('/API/GetGift', (req, res)=>{
    res.status(200).send(JSON.stringify(giftconf.map(values=>{return {"name": values['name'], "point": values['point']};})));
});


//appの最後じゃないとダメ(404の時HTML返す)
app.use(function(req, res, next){
    res.status(404).send(fs.readFileSync('./webpage/error/404page.html', {encoding: 'utf-8'}));
});


/**@description (JSONの要素が含まれる)配列の中から条件に合うJSON要素を取り出す。(ひとつのみ)
 * @param {any} object 対象の配列
 * @param {string} key 検索に利用するキー
 * @param {string} value キーに対応する値
 * @param {string} target これを指定すると該当するJSON要素の中の該当するキーに対応する値を返す
*/
function objsearch(object, key, value, target=""){
    try{
        if(!object || !key || !value){
            return undefined;
        }else if(!target){
            return object.find(conf=> conf[key]==value);
        }else{
            return object.find(conf=> conf[key]==value)[target];
        }
    }catch{
        //targetが存在しえないobjectを扱うなどするとエラーになるため
        return undefined;
    }
}
//たとえば console.log(objsearch(qrconf, "qr", "tcu_Ichigokan", "location")); だと "一号館" になる。

//SQL操作Promise化 @@@@@グローバルにconnectionとかtabeleとかloggerあること前提@@@@@
/**@description  データはモノによって型整えてから返す*/
function squery(query, values=[]){
    return new Promise((resolve, reject)=>{
        let sq = connection.query(query, values, (err, results)=>{
            if(err){
                reject(err);
            }else{
                logger.info(sq['sql']);
                if(results.length==0){
                    reject(new Error("not found"));
                }else if(results.length==1){
                    if(Object.values(results[0]).length==1){
                        resolve(Object.values(results[0])[0]);
                    }else{
                        resolve(results[0]);
                    }
                }else{
                    resolve(results);
                }
            }
        });
    });
}
function sbegin(){
    return new Promise((resolve, reject)=>{
        connection.beginTransaction(err=>{
            if(err){
                reject(new Error("begin error"));
            }else{
                resolve();
            }
        });
    });
}
function scommit(){
    return new Promise((resolve, reject)=>{
        connection.commit(err=>{
            if(err){
                reject(new Error("commit error"));
            }else{
                resolve();
            }
        });
    });
}
function srollback(){
    return new Promise((resolve, reject)=>{
        connection.rollback(()=>{
            resolve();
        });
    });
}

/**@description 現在時刻を「yyyy/mm/dd hh:mm:ss」で返す*/
function now(){
    let now = new Date();
    let year = now.getFullYear();
    let month = ('0' + (now.getMonth() + 1)).slice(-2);
    let date = ('0' + now.getDate()).slice(-2);
    let hour = ('0' + now.getHours()).slice(-2);
    let minute = ('0' + now.getMinutes()).slice(-2);
    let seconds = ('0' + now.getSeconds()).slice(-2);
    return `${year}/${month}/${date} ${hour}:${minute}:${seconds}`
}

/**@description ユーザーエージェントからOSを判別する */
function getos(user_agent){
    let os="";
    if(user_agent.indexOf("Android")!=-1){
        os="Android"
    }else if(user_agent.indexOf("iPhone")!=-1){
        os="iPhone"
    }else if(user_agent.indexOf("iPad")!=-1){
        os="iPad"
    }else if(user_agent.indexOf("Windows")!=-1){
        os="Windows"
    }else if(user_agent.indexOf("Macintosh")!=-1){
        os="Macintosh"
    }else if(user_agent.indexOf("Linux")!=-1){
        os="Linux"
    }else{
        os="Unknown"
    }
    return os;
}