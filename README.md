# 包裝備料排程工具 Packaging Schedule Board

> **English summary** — A lightweight production-scheduling board built on Google Sheets + Apps Script for a factory's packaging-material staff. Work orders flow through assembly → testing → packaging on a single packaging line. Staff only enter a *queue order* and an *estimated number of time slots*; the script auto-schedules every work order onto a half-shift timeline (morning / afternoon / overtime, with holiday rules), computes the **latest time packaging materials must be ready**, shows traffic-light alerts, renders a Gantt chart, and forecasts how many orders' materials will be sitting on the shop floor. Inserting a rush order is a one-cell edit (e.g. `1.5`), and everything downstream reflows automatically. Designed for busy, non-technical, and older colleagues: no new software, works on phones, and permissions use Google's built-in sharing.

---

## 為什麼做這個工具

我在製造業擔任包裝備料人員。產線做到包裝階段前，我要先把包材準備好：

- **備太早**：現場沒地方放包材
- **備太晚**：產線停下來等料，回頭追著要東西

公司原本只有一張文字表格，上面只有「預計出貨日」，沒有各階段的時間。生管又常常當天才決定做哪張工單，外包組裝品回廠時還會插隊包裝。結果排程很難一眼看懂，也掌握不到每張工單的進度。

## 解法

不另外買軟體，直接用公司已經在用的 **Google 試算表**，加上一段 **Apps Script** 自動計算：

| 工作表 | 用途 |
|---|---|
| ① 工單排程 | 唯一的輸入處。一列一張工單，填狀態、**包裝順序**、**包裝時段數** |
| ② 工作日曆 | 每天哪些時段上班，國定假日、颱風天勾掉即可 |
| ③ 包裝備料清單 | 依包裝時間自動排序，顯示**最晚備料時間**和燈號，手機上可以直接勾「已備料」 |
| ④ 甘特圖 | 未來兩週的組裝、測試、包裝時間軸，加上「現場包材數」預估 |
| ⑤ 選項設定 | 時段時間、燈號提前量、下拉選單內容 |

### 核心設計

1. **排隊制排程**：包裝線一次只做一張工單，所以只要決定「順序」和「需要幾個時段」，開始和結束時間由系統依工作日曆往後排。
2. **插隊只改一格**：外包品回廠要先包，把它的順序填 `1.5`，就會排到第 1 和第 2 張中間，後面全部自動順延。
3. **半時段精度**：每天分上午、下午、晚上加班，每個時段再分前後半；週六只有上午、下午，週日休息。
4. **備料期限規則**：
   - 下午要包裝 → 上午備好；晚上要包裝 → 下午備好
   - 早上要包裝 → 前一個上班日下午備好
   - 假日要包裝 → 假日前最後一個上班日備齊（備料人員假日不上班）
5. **燈號**：🔴 現在備／逾期、🟡 下個時段備、🟢 已備料、⚪ 還早。
6. **現場包材數**：預估每個時段現場會同時放幾張單的包材，避免太早備料塞爆空間。
7. **出貨風險**：預計包裝結束日晚於出貨日時，出貨日欄位會標紅。

### 為了忙碌、年長的同事做的取捨

- 不用安裝新軟體，Google 試算表的手機 App 就能看、能勾選
- 同事只需要看「包裝備料清單」的顏色
- 自動計算的欄位會鎖住，避免誤改公式
- 權限直接用 Google 的共用設定（編輯者／檢視者）

## 畫面截圖

> 截圖待補。

## 安裝（約 5 分鐘）

1. 用公司 Google 帳號建立一份**新的空白試算表**。
2. 上方選單「擴充功能 → Apps Script」。
3. 把 [`src/Code.gs`](src/Code.gs) 的內容**全部複製**，貼上取代編輯器裡原本的程式碼，按 💾 儲存。
4. 上方函式選單選 `setup`，按「▶ 執行」。
5. 第一次會要求授權：選你的帳號 →「進階」→「前往（專案名稱）」→「允許」。
   - 會看到「Google 尚未驗證這個應用程式」，這是因為程式是你自己的，不是 Google 審核過的公開應用程式，屬於正常現象。
6. 回到試算表，五張工作表和 9 筆範例資料就建好了。

詳細的操作方式請看 [使用說明](docs/使用說明.md)，完整規格請看 [規格書](docs/規格書.md)。

### 共用給同事

「共用」按鈕 → 一般存取權選 **「限公司網域」**（不要選「知道連結的任何人」）→ 依人設定「編輯者」或「檢視者」。

## 技術說明

- **Google Apps Script（V8）**，單一檔案，沒有外部相依套件
- 排程核心是**純函式**（不碰試算表 API），可以在 Node.js 單獨測試
- 時間用「試算表日期序號 × 6 + 時段 × 2 + 半段」編成整數鍵值，排隊、跳過停工時段、找備料期限都靠二分搜尋
- 以**可安裝的編輯觸發器**（用擁有者身分執行）即時重算，所以一般編輯者也能在鎖定的工作表上勾選；另外每 30 分鐘自動更新一次燈號
- `LockService` 避免多人同時編輯時重複計算

### 執行測試

```bash
npm test
```

- `tests/core.test.js`：備料期限、排隊、插隊、假日、停工、燈號、甘特圖統計
- `tests/setup.test.js`：用模擬的試算表環境（`tests/gas-mock.js`）跑完整的建置 → 勾選 → 改狀態流程

## 未來擴充

- 前置排程：訂單啟動、物料進貨
- 材料清單：組裝材料、包裝材料（以工單編號對應）
- 從 ERP 系統匯出的工單資料直接貼上匯入
- 各階段完成簽核

## 授權

[MIT](LICENSE)
