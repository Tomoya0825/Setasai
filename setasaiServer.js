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
                //不正なJSONデータが送られてきた場合
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

process.on('uncaughtException', ex=>{
    logger.fatal(ex);
});
process.on('unhandledRejection', ex=>{
    logger.fatal(ex);
}); //エラーの処理もれはfatalで記録

//ufwなどで 443ポート開放済み必須 (実行にroot権限必須)
https.createServer({
    key: fs.readFileSync(serverconf['certificate_file']['key']),
    cert: fs.readFileSync(serverconf['certificate_file']['cert']),
    ca: fs.readFileSync(serverconf['certificate_file']['ca'])
},app).listen(443);
//httpリダイレクト用。 80番ポート解放必須
const exhttp = express();
http.createServer(exhttp.all('*', (req, res)=>{
    res.redirect(301, `https://${req['hostname']}${req['url']}`);
})).listen(80);



/*  ログ漏れないか確認
error   サーバ処理エラー 基本500返す
warn    へんなリクエスト投げられたとき 基本400返す
indo    SQLの履歴(squery内部でとっている)
*/

logger.trace("Server Start");


//auth_code生成用 I i l 1 O o 0 J j は見ずらいかもしんないので使わない
const S1 = "abcdefghkmnpqrstuvwxyz23456789";
const S2 = "123456789"

//#####ユーザ登録API#####
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
        return squery("INSERT INTO ??(auth_code, user_agent, os, created_at, rally_data, exchanged_gifts, suggest_type) VALUES (?,?,?,?,?,?,?);",
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
app.post('/API/RecordQR', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let location = objsearch(qrconf, "qr", req.body['qr'], "location");    //定義されていないもの投げられたとき対策

    if(objsearch(qrconf, "location", location, "contents_type")=="gift_exchange"){
        res.status(200).json({"url": `https://${req['hostname']}/gift_exchange`});
    }else{
        new Promise((resolve, reject)=>{
            if(!id || !auth_code || !location){
                res.status(400).send("invalid parameter");
                logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, qr: ${req.body['qr']}`);
                reject(new Error("req error"));
            }else{
                resolve();
            }
        }).then(()=>{
            return getuserdata(id, auth_code);  //認証失敗したときは「Error(auth faild)」を返す
        }).then(userdata=>{
            let userstatus = getuserstatus(userdata);
            if(userstatus['recorded_locations'].some(value=> value==location)){ //ユーザの記録済みQRと照会
                if(userstatus['answerd_locations'].some(value=> value==location)){  //ユーザーの回答済みQRと照会
                    //記録済みかつ回答済み
                    res.status(400).json({"error": "alrady answerd"});
                }else{
                    //記録済みだが未回答
                    res.status(200).json({"url": `https://${req['hostname']}/${objsearch(qrconf, "location", location, "contents_type")}?location=${location}`});
                }
            }else{
                //未記録
                userdata['rally_data'].push({
                    "location": location,
                    "time": now(),
                    "point": 0,
                    "answer": []
                });
                let typehistory = userdata['rally_data'].map(value=> objsearch(qrconf, "location", value['location'], "group"));
                suggestconf.some(conf=>{
                    if(conf['patterns'].some(value=> JSON.stringify(value)==JSON.stringify(typehistory.slice(-value.length)))){
                        //サジェスト一致したら保存
                        squery("UPDATE ?? SET suggest_type=? WHERE id=? AND auth_code=?;",[table, conf['type'], id, auth_code]).then(()=>{
                            return true;  //最初に一致したものにする  @@@@@つまりはsuggestconfで上に記述するもののほうが優先順位が高い@@@@@
                        });
                    }
                });
                squery("UPDATE ?? SET rally_data=? WHERE id=? AND auth_code=?;",[table, JSON.stringify(userdata['rally_data']), id, auth_code]).then(()=>{
                    res.status(200).json({"url": `https://${req['hostname']}/${objsearch(qrconf, "location", location, "contents_type")}?location=${location}`});
                });
            }
        }).catch(ex=>{
            if(ex['massage']=="auth faild"){
                res.status(400).json({"error": "auth faild"});
                logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
            }else{
                res.status(500).json({"error": "server error"});
                logger.error(ex);
            }
        });
    }
});

//#####QR対象固有ページコンテンツ表示API#####
app.post('/API/UniquePage', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let location =　objsearch(qrconf, "location", req.body['location'], "location");    //定義されていないもの投げられたとき対策

    new Promise((resolve, reject)=>{
        if(!id || !auth_code || !location){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, qr: ${req.body['qr']}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        return getuserdata(id, auth_code);  //認証失敗したときは「Error(auth faild)」を返す
    }).then(userdata=>{
        let userstatus = getuserstatus(userdata);
            if(userstatus['recorded_locations'].some(value=> value==location)){ //ユーザの記録済みQRと照会
                if(userstatus['answerd_locations'].some(value=> value==location)){  //ユーザーの回答済みQRと照会
                    //記録済みかつ回答済み
                    res.status(400).json({"error": "alrady answerd"});
                }else{
                    //記録済みだが未回答
                    res.status(200).json({"contents": objsearch(qrconf, "location", location, "contents")});
                }
            }else{
                //未記録
                logger.warn(`[Access Denied] id: ${id}, location: ${location}`)
                res.status(400).json({"error":"access denied"});
            }
    }).catch(ex=>{
        if(ex['massage']=="auth faild"){
            res.status(400).json({"error": "auth faild"});
            logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
        }else{
            res.status(500).json({"error": "server error"});
            logger.error(ex);
        }
    });
});


//#####QR対象固有ページ回答記録API#####
app.post('/API/Recordanswer', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let location =　objsearch(qrconf, "location", req.body['location'], "location");    //定義されていないもの投げられたとき対策
    let answer = JSON.parse(JSON.stringify(req.body['answer']));  //念のためエスケープ

    new Promise((resolve, reject)=>{
        if(!id || !auth_code || !location || !answer){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, qr: ${req.body['qr']}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        return getuserdata(id, auth_code);  //認証失敗したときは「Error(auth faild)」を返す
    }).then(userdata=>{
        let userstatus = getuserstatus(userdata);
            if(userstatus['recorded_locations'].some(value=> value==location)){ //ユーザの記録済みQRと照会
                if(userstatus['answerd_locations'].some(value=> value==location)){  //ユーザーの回答済みQRと照会
                    //記録済みかつ回答済み
                    res.status(400).json({"error": "alrady answerd"});
                }else{
                    //記録済みだが未回答
                    let result = check_answer(location, answer);
                    if(result['point']==0){
                        logger.warn(`[Invalid Answer] id: ${id}, answer: ${answer}`);
                        res.status(400).json({"error":"bad request"});
                    }else{
                        let index = userdata['rally_data'].findIndex(value=> value['location']==location);
                        if(result['result']){   //クイズの時は正誤を格納
                            userdata['rally_data'][index]['answer'] = result['result'];
                        }else{
                            userdata['rally_data'][index]['answer'] = answer;
                        }
                        userdata['rally_data'][index]['point'] = result['point'];
                        squery("UPDATE ?? SET rally_data=? WHERE id=? AND auth_code=?;",[table, JSON.stringify(userdata['rally_data']), id, auth_code]).then(()=>{
                            res.status(200).json(result);
                        });
                    }
                }
            }else{
                //未記録
                logger.warn(`[Access Denied] id: ${id}, location: ${location}`)
                res.status(400).json({"error":"access denied"});
            }
    }).catch(ex=>{
        if(ex['massage']=="auth faild"){
            res.status(400).json({"error": "auth faild"});
            logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
        }else{
            res.status(500).json({"error": "server error"});
            logger.error(ex);
        }
    });
});
function check_answer(location, answer){    //意図的に定義にない回答を投げられたりしたとき対策やクイズの回答チェックなど
    try{
        //オブジェクトの形が曖昧なのでforEach使用していない
        let conf = objsearch(qrconf, "location", location);
        if(conf['contents_type']=="enquete"){
            for(i in conf['contents']['enquete']){
                if(conf['contents']['enquete'][i]['type']=="check"){
                    for(j in answer[i]){
                        if(!conf['contents']['enquete'][i]['choice'].some(value=> value==answer[i][j])){
                            return {"point": 0};
                        }
                    }
                }else if(conf['contents']['enquete'][i]['type']=="radio"){
                    if(!conf['contents']['enquete'][i]['choice'].some(value=> value==answer[i])){
                        return {"point": 0};
                    }
                }else if(conf['contents']['enquete'][i]['type']=="write"){
                    //自由記述なので確認なし(エスケープ済み)
                }
            }
            return {"point": objsearch(qrconf, "location", location, "point")};
        }else if(conf['contents_type']=="quiz"){
            if(answer == objsearch(qrconf, "location", location, "answer")){
                return({
                    "result": "correct",
                    "point": objsearch(qrconf, "location", location, "point_correct")
                });
            }else{
                return({
                    "result": "wrong",
                    "point": objsearch(qrconf, "location", location, "point_wrong")
                });
            }
        }else if(conf['contents_type']=="vote"){
            if(!conf['contents']['choice'].some(value=> value==answer)){
                return {"point": 0};
            }else{
                return {"point": objsearch(qrconf, "location", location, "point")};
            }
        }else{
            //ないはず
        }
    }catch{
        return {"point": 0};
    }
}


//#####景品交換API#####
app.post('/API/RecordGift', (req, res)=>{
    let id = req.body['id'];
    let auth_code = req.body['auth_code'];
    let giftname = objsearch(giftconf, "giftname", req.body['giftname'], "giftname");   //定義されていないもの投げられたとき対策
    new Promise((resolve, reject)=>{
        if(!id || !auth_code || !gift){
            res.status(400).send("invalid parameter");
            logger.warn(`[Invalid Parameter] id: ${id}, auth_code: ${auth_code}, gift: ${req.body['gift']}`);
            reject(new Error("req error"));
        }else{
            resolve();
        }
    }).then(()=>{
        return getuserdata(id, auth_code);  //認証失敗したときは「Error(auth faild)」を返す
    }).then(()=>{
        let userstatus = getuserstatus(userdata);
        if(!userstatus['exchangeable_gifts'].some(value=> value==giftname)){
            if(userstatus['exchanged_gifts'].some(value=> value==giftname)){
                //交換済み
                res.status(400).json({"error": "alrady exchanged"});
            }else{
                //交換不可能(ポイント不足)
                res.status(400).json({"error": "insufficient point"});
            }
        }else{
            //交換可能
            userdata['exchanged_gifts'].push(giftname);
            squery("UPDATE ?? SET exchanged_gifts=? WHERE id=? AND auth_code=?;",[table, JSON.stringify(userdata['exchanged_gifts']), id, auth_code]).then(()=>{
                res.status(200).json({"results": "ok"});
            });
        }
    }).catch(ex=>{
        if(ex['massage']=="auth faild"){
            res.status(400).json({"error": "auth faild"});
            logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
        }else{
            res.status(500).json({"error": "server error"});
            logger.error(ex);
        }
    });
});

//#####行動履歴によるサジェストAPI#####
app.post('/API/Suggest', (req, res)=>{
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
        return getuserdata(id, auth_code);
    }).then(userdata=>{
        res.status(200).json({"message": objsearch(suggestconf, "type", userdata['suggest_type'], "message")});
    }).catch(ex=>{
        if(ex['massage']=="auth faild"){
            res.status(400).json({"error": "auth faild"});
            logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
        }else{
            res.status(500).json({"error": "server error"});
            logger.error(ex);
        }
    });
});

//#####ユーザ状態照会API#####
app.post('/API/GetData', (req, res)=>{
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
        return getuserdata(id, auth_code);
    }).then(userdata=>{
        res.status(200).json(getuserstatus(userdata));
    }).catch(ex=>{
        if(ex['massage']=="auth faild"){
            res.status(400).json({"error": "auth faild"});
            logger.warn(`[Auth Faild] id: ${id}, auth_code: ${auth_code}`);
        }else{
            res.status(500).json({"error": "server error"});
            logger.error(ex);
        }
    });
});

//#####QRロケーション一覧表示API#####
app.post('/API/GetLocation', (req, res)=>{
    res.status(200).send(JSON.stringify(qrconf.map(values=>values['location'])));
});

//#####景品一覧表示API#####
app.post('/API/GetGift', (req, res)=>{
    res.status(200).send(JSON.stringify(giftconf.map(values=>{return {"name": values['name'], "point": values['point']};})));
});

//appの最後じゃないとダメ(404の時HTML返す)
app.use(function(req, res, next){
    res.status(404).send(fs.readFileSync('./webpage/error/404page.html', {encoding: 'utf-8'}));
});

/*
確認事項(問題ありならレスポンスでエラーを返すもの)

## ユーザ登録
確認なし

## QR記録
パラメータがそろっているか
idとauth_codeでの認証
リクエストされたqrが定義されているものか
qrが既に記録済みのものかどうか
qrに対応するコンテンツに回答済みかどうか

## 固有ページ表示
パラメータがそろっているか
idとauth_codeでの認証
リクエストされたlocationが定義されているものか
locationが既に記録済みのものかどうか
locationに対応するコンテンツに回答済みかどうか

## 固有ページ回答記録
パラメータがそろっているか
idとauth_codeでの認証
リクエストされたlocationが定義されているものか
locationが既に記録済みのものかどうか
locationに対応するコンテンツに回答済みかどうか
リクエストされたanswerの内容は定義されたものと一致するか

## 景品交換
パラメータがそろっているか
idとauth_codeでの認証
交換済みでないか
合計ポイントは足りるか
*/



/**@description ユーザの情報をDBから取得 */
function getuserdata(id, auth_code){
    return new Promise((resolve, reject)=>{
        squery("SELECT rally_data, exchanged_gifts, suggest_type FROM ?? WHERE id=? AND auth_code=?", [table, id, auth_code]).then(results=>{
            resolve({
                "rally_data": JSON.parse(results['rally_data']),
                "exchanged_gifts": JSON.parse(results['exchanged_gifts']),
                "suggest_type": results['suggest_type']
            });
        }).catch(ex=>{
            if(ex['message']=='not found'){
                reject(new Error("auth faild"));
            }else{
                reject(ex);
            }
        });
    });
}

/**@description ユーザーの情報をまとめる */
function getuserstatus(userdata){
    let rally_data = userdata['rally_data'];
    let exchanged_gifts = userdata['exchanged_gifts'];
    let suggest_type = userdata['suggest_type'];

    let recorded_locations=[];
    let answerd_locations=[];
    let total_point = 0;
    let exchangeable_gifts = [];

    for(i in rally_data){
        recorded_locations.push(rally_data[i]['location']);
        if(rally_data[i]['point']>0){
            total_point += rally_data[i]['point'];
            answerd_locations.push(rally_data[i]['location']);
        }
    }
    exchangeable_gifts = giftconf.filter(value=> value['point']<= total_point);
    exchangeable_gifts = giftconf.filter(value=> value['point']<= total_point && !exchanged_gifts.some(exval=> exval== value['giftname']));
    
    return({
        "recorded_locations": recorded_locations,   //記録済みQRのLocationの配列
        "answerd_locations": answerd_locations,     //回答済みQRのLocationの配列
        "total_point": total_point,                 //合計ポイント
        "exchangeable_gifts": exchangeable_gifts,   //ポイントが足りるかつ未交換の交換可能ギフト
        "exchanged_gifts": exchanged_gifts,         //交換済みのギフト
        "suggest_type": suggest_type                //おすすめタイプ
    });

}


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
//トランザクション使う場合
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