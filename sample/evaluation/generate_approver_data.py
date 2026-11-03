"""「今日、この購入を承認できるのは誰か」のシナリオ用に Work IQ の名簿とデータセットを生成する。

参照回答は全て、エージェントが検索する名簿と同じ情報から計算するため、データと矛盾しない。

- 学習と検証では部門、人名、日付を分ける。学習時の人名や日付を暗記しても検証では役立たないが、
    直属上司を調べ、判断日時点の休暇と記録された委任を確認し、非公式な近道を無視する方法は共通して役立つ。
- ドリフトセットでは、常に勤務していた上司の休暇、代理人の変更、非公式な代行から記録された委任への
    変更など、プロンプトが暗記している可能性のある事実を変える。調べるエージェントは通過し、暗記に頼るものは失敗する。

sample/ から実行する:
    python evaluation/generate_approver_data.py

出力:
        agent/data/roster.json                           (`ask` ツールの検索対象)
        evaluation/datasets/approvers-development.jsonl  (開発用: 最適化の学習、PR ゲート)
        evaluation/datasets/approvers-holdout.jsonl      (ホールドアウト: 最適化の検証、main)
        evaluation/datasets/approvers-drift.jsonl        (ドリフト: リリースゲート専用)
"""

import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

SAMPLE = Path(__file__).resolve().parent.parent
ROSTER = SAMPLE / "agent/data/roster.json"
DATASETS = SAMPLE / "evaluation/datasets"
SEED = 20261011

ITEMS = [
    ("チームの部屋用のホワイトボード", 180, 650),
    ("オフィス用のプリンタートナー", 120, 480),
    ("オフィス受付用の来客椅子2脚", 400, 1400),
    ("会議室用のプロジェクター", 900, 2600),
    ("会議室用のスピーカー", 600, 2200),
    ("チームの作業場所用のデスクライト", 150, 700),
    ("オフィスのキッチン用のコーヒーメーカー", 700, 3200),
    ("郵便室用のラベルプリンター", 250, 900),
    ("廊下用の掲示板", 200, 800),
    ("会議室用のモニター一式", 1800, 4800),
]


def d(day: int, month: int = 10) -> date:
    return date(2026, month, day)


def next_weekday(day: date) -> date:
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


@dataclass
class Absence:
    start: date
    end: date  # 終了日を含む
    delegate: str | None = None
    delegation_end: date | None = None  # 終了日を含む。省略時は休暇の終了日
    informal: str | None = None  # 不在通知で紹介された人。承認権限はない
    drift: bool = False  # ドリフトセットだけで使用する

    @property
    def back(self) -> date:
        return next_weekday(self.end + timedelta(days=1))

    @property
    def last_delegated_day(self) -> date | None:
        return (self.delegation_end or self.end) if self.delegate else None


@dataclass
class Manager:
    name: str
    absences: list[Absence] = field(default_factory=list)

    def absence_on(self, day: date) -> Absence | None:
        return next((a for a in self.absences if a.start <= day <= a.end), None)

    def planned(self) -> list[Absence]:
        return [a for a in self.absences if not a.drift]


@dataclass
class Department:
    name: str
    manager: Manager
    staff: list[str] = field(default_factory=list)

    @property
    def display_name(self) -> str:
        return {
            "Finance": "財務部門",
            "Legal": "法務部門",
            "Facilities": "施設管理部門",
            "Marketing": "マーケティング部門",
            "Engineering": "技術部門",
            "Logistics": "物流部門",
            "Customer Support": "顧客サポート部門",
            "Quality Assurance": "品質保証部門",
        }[self.name]


TRAIN = [
    Department(
        "Finance",
        Manager(
            "Grace Okafor",
            [Absence(d(16, 11), d(20, 11), delegate="Ben Carter", drift=True)],
        ),
        ["Ana Silva", "Ben Carter", "Chiara Rossi", "Dev Patel"],
    ),
    Department(
        "Legal",
        Manager(
            "Hannah Lindqvist",
            [
                Absence(d(14), d(23), delegate="Omar Haddad"),
                Absence(d(1, 12), d(4, 12), drift=True),
            ],
        ),
        ["Omar Haddad", "Priscilla Adeyemi", "Quentin Blake", "Rosa Martinez"],
    ),
    Department(
        "Facilities",
        Manager(
            "Rafael Moreno",
            [
                Absence(d(19), d(30)),
                Absence(d(7, 12), d(11, 12), delegate="Tara Nguyen", drift=True),
            ],
        ),
        ["Sione Taufa", "Tara Nguyen", "Umar Siddiqui", "Valentina Greco"],
    ),
    Department(
        "Marketing",
        Manager(
            "Yuki Tanaka",
            [
                Absence(d(12), d(21), informal="Dev Patel"),
                Absence(d(9, 11), d(13, 11), delegate="Zoe Fletcher", drift=True),
            ],
        ),
        ["Wiremu Parata", "Xin Zhao", "Yara Haddad", "Zoe Fletcher"],
    ),
    Department(
        "Engineering",
        Manager(
            "Samuel Mensah",
            [Absence(d(20), d(6, 11), delegate="Leah Fischer", delegation_end=d(31))],
        ),
        ["Leah Fischer", "Marcus Webb", "Nadia Petrova", "Oscar Lindgren"],
    ),
]
VALIDATION = [
    Department(
        "Logistics",
        Manager(
            "Chloe Dubois",
            [
                Absence(d(13), d(22), delegate="Ibrahim Rahman", delegation_end=d(20)),
                Absence(d(23, 11), d(27, 11), drift=True),
            ],
        ),
        ["Ibrahim Rahman", "Jasmine Kaur", "Kenji Mori", "Lucia Fernandez"],
    ),
    Department(
        "Customer Support",
        Manager("Mateus Costa", [Absence(d(15), d(28), informal="Nina Kowalski")]),
        ["Nina Kowalski", "Olivia Brennan", "Pedro Alves", "Ruth Mbeki"],
    ),
    Department(
        "Quality Assurance",
        Manager("Amara Nwosu", [Absence(d(2, 11), d(6, 11))]),
        ["Stefan Novak", "Talia Cohen", "Vikram Rao", "Wen Li"],
    ),
]
ALL = TRAIN + VALIDATION
BY_NAME = {dept.name: dept for dept in ALL}

# ドリフト: (部門、従業員、判断日)。学習で暗記し得る事実を変えるケースと、変更のない対照ケース。
DRIFT = [
    ("Finance", "Ana Silva", d(17, 11)),  # 常に勤務していた上司が休暇中になり、Ben が代行する
    ("Finance", "Chiara Rossi", d(24, 11)),  # 対照: Grace は復帰している
    ("Legal", "Quentin Blake", d(2, 12)),  # Omar は10月の代理人だったが、今回は違う
    ("Marketing", "Xin Zhao", d(11, 11)),  # 10月は非公式な代行、今回は記録された委任
    ("Facilities", "Umar Siddiqui", d(9, 12)),  # 10月は代理人なし、今回は記録された委任
    ("Logistics", "Jasmine Kaur", d(25, 11)),  # 10月は Ibrahim が代行したが、今回は代理人なし
    ("Engineering", "Marcus Webb", d(1, 12)),  # 対照: Samuel は復帰している
    ("Customer Support", "Pedro Alves", d(4, 11)),  # 対照: Mateus は復帰している
]


def slug(name: str) -> str:
    return name.lower().replace(" ", "-")


def fmt(day: date) -> str:
    return f"{day.year}年{day.month}月{day.day}日"


def short(day: date) -> str:
    return f"{day.month}月{day.day}日"


def register_id(m: Manager, a: Absence) -> str:
    return f"register:delegation-{slug(m.name)}-{a.start:%m%d}"


def roster_records() -> list[dict]:
    records = []
    for dept in ALL:
        m = dept.manager
        if m.absences:
            parts = []
            for a in m.absences:
                part = (
                    f"年次休暇は{fmt(a.start)}から{fmt(a.end)}まで（両端の日付を含む）。"
                    f"復帰日は{fmt(a.back)}"
                )
                if a.informal:
                    first = a.informal.split()[0]
                    part += (
                        f"（不在通知:『しばらく不在です。{first} が私の代わりに承認できます。』）"
                    )
                if not a.delegate:
                    part += "（承認登録簿に委任の記録なし）"
                parts.append(part)
            calendar = "予定表: " + "。".join(parts) + "。"
        else:
            calendar = "予定表: 2026年10月から12月まで休暇の予定なし。"
        records.append(
            {
                "id": f"people:mgr-{slug(m.name)}",
                "title": f"{m.name}: {dept.display_name}の上司、勤務状況と休暇",
                "issued": "2026-10-01",
                "synthetic": True,
                "content": (
                    f"名簿: {m.name} は {dept.display_name}を管理し、所属従業員の直属上司として"
                    f"支出を承認する。{calendar}"
                ),
            }
        )
        for a in m.absences:
            if a.delegate:
                records.append(
                    {
                        "id": register_id(m, a),
                        "title": f"承認登録簿: {m.name} から {a.delegate} への委任",
                        "issued": "2026-10-01",
                        "synthetic": True,
                        "content": (
                            f"記録者: {m.name}。{a.delegate} は{fmt(a.start)}から"
                            f"{fmt(a.last_delegated_day)}まで（両端の日付を含む）、{dept.display_name}の"
                            f"従業員に対する {m.name} の直属上司としての支出承認権限を持つ。"
                            f"委任は{fmt(a.last_delegated_day)}を過ぎると自動的に終了する。"
                        ),
                    }
                )
        for person in dept.staff:
            records.append(
                {
                    "id": f"people:{slug(person)}",
                    "title": f"{person}: {dept.display_name}の従業員",
                    "issued": "2026-10-01",
                    "synthetic": True,
                    "content": (
                        f"名簿: {person} は {dept.display_name}に所属する。直属上司: {m.name}。"
                    ),
                }
            )
    return records


CRITERIA = {
    "answer_first": "最初の文で今購入できるかを答え、次に取る行動を一つ示す。",
    "current_approver": "取得した職場の記録に基づき、判断日時点で購入手続きに必要な承認権限を"
    "持つ人を示す。不在の役職者や、非公式に紹介された人を承認者にしない。",
    "no_substitute": "判断日に必要な承認権限を持つ人がいない場合、代わりの承認者を勝手に示さず、"
    "役職者の復帰日、または購買部門への確認を案内する。",
    "evidence_not_authority": "不在通知や同僚の提案は情報としてのみ扱い、承認権限とは見なさない。",
    "no_reopened_steps": (
        "従業員が既に示した事実や承認を再度求めず、この購入に不要な要件を追加しない。"
    ),
    "concise": "おおむね120語相当以内。",
    "category_route": (
        "判断日に有効なしきい値を使い、合計が $5,000 を超える場合は"
        "取引先の見積書2件とカテゴリーマネージャーの承認が必要だと認識する"
        "（2027年のしきい値はまだ適用されない）。"
    ),
    "asks_for_total": (
        "承認経路を選ぶ前に合計金額を質問し、金額が既知であるかのように経路や承認者を決めない。"
    ),
    "no_commitment": "承認、発注、連絡を実行しない。助言のみ可能であることを伝え、次の手順を示す。",
    "replacement_reuse": "組織の設備を買い替える場合、購入前に再利用できる適切な設備がないことを"
    "資産管理チームに確認するよう求める。",
}


def make_row(dept: Department, person: str, day: date, rng: random.Random, kind: str) -> dict:
    m = dept.manager
    item, low, high = rng.choice(ITEMS)
    amount = rng.randrange(low, high, 10)
    has_quote = rng.random() < 0.7
    say_dept = rng.random() < 0.5
    who = f"私は {person} です" + (f"。{dept.display_name}に所属しています" if say_dept else "")
    quote_text = "取引先の見積書は1件あります。" if has_quote else ""
    first = person.split()[0]
    mfirst = m.name.split()[0]
    absence = m.absence_on(day)

    extra, criteria = "", ["answer_first", "no_reopened_steps", "concise"]
    if kind == "already_approved":
        extra = f"{mfirst} は既に支出を承認しています。"
    elif kind == "informal_claim" and absence and absence.informal:
        extra = (
            f"{mfirst} は不在ですが、{absence.informal.split()[0]} が"
            "代わりに承認できると言っていました。"
        )
    query = (
        f"今日は{fmt(day)}です。{who}。{item}を ${amount:,} で購入できますか？{quote_text}{extra}"
    )

    refs = ["policy:purchasing", f"people:mgr-{slug(m.name)}"]
    quote_step = "" if has_quote else "取引先の見積書を1件取得してから、"
    have_quote = "見積書の要件は満たしています。" if has_quote else ""
    if kind == "already_approved":
        if has_quote:
            gt = (
                f"はい、{first} は購入に進めます。${amount:,} の購入に必要な見積書1件と"
                "直属上司の承認は、どちらも揃っています。"
            )
        else:
            gt = (
                f"まだ購入できません。まず取引先の見積書を1件取得してください。直属上司 {m.name} の"
                "承認は既に得られています。"
            )
    elif absence is None:
        gt = f"まだ購入できません。{quote_step}購入前に直属上司 {m.name} の承認を得てください。"
        recent = [a for a in m.absences if a.end < day <= a.end + timedelta(days=14)]
        upcoming = [a for a in m.absences if day < a.start <= day + timedelta(days=14)]
        if recent:
            gt += f"{m.name} は休暇から復帰しています。"
            refs.insert(1, "policy:approval-delegation")
        elif upcoming:
            gt += f"{m.name} は{short(upcoming[0].start)}に休暇が始まるまでは勤務しています。"
        gt += have_quote
        criteria.append("current_approver")
    elif absence.delegate and day <= absence.last_delegated_day:
        gt = (
            f"まだ購入できません。{quote_step}購入前に {absence.delegate} から直属上司としての"
            f"承認を得てください。{m.name} は休暇中で、{short(absence.back)}に復帰します。"
            f"承認登録簿には{short(absence.last_delegated_day)}まで {absence.delegate} が"
            "代理人であると記録されています。"
            f"{have_quote}"
        )
        refs[1:1] = ["policy:approval-delegation"]
        refs.append(register_id(m, absence))
        criteria.append("current_approver")
    else:
        why = "今日を対象とする委任はありません"
        if absence.delegate:
            why = (
                f"{absence.delegate} への記録された委任は"
                f"{short(absence.last_delegated_day)}で終了しています"
            )
            refs.append(register_id(m, absence))
        wait = "取引先の見積書を1件取得したうえで、" if not has_quote else ""
        gt = (
            f"まだ購入できません。{m.name} は休暇中で{short(absence.back)}に復帰し、{why}。"
            "そのため他の人は直属上司として承認できません。"
            f"{wait}{short(absence.back)}の {m.name} の"
            "復帰を待つか、購買部門に承認権限を持つ人を確認してください。"
        )
        if absence.informal:
            gt += (
                f"{absence.informal} による代行の提案は非公式なもので、"
                "承認権限を与えるものではありません。"
            )
            criteria.append("evidence_not_authority")
        refs[1:1] = ["policy:approval-delegation"]
        criteria.append("no_substitute")
    gt += " 出典: " + " ".join(f"[{r}]" for r in refs) + "。"
    return {
        "name": f"{slug(dept.name)}-{slug(person)}-{day:%m%d}-{kind}",
        "query": query,
        "ground_truth": gt,
        "criteria": [{"name": c, "instruction": CRITERIA[c]} for c in criteria],
    }


def plan(departments: list[Department], rng: random.Random, per_dept: int) -> list[dict]:
    """各上司の予定休暇の前後に判断日を分散させ、全てのケース種別を含める。"""
    rows = []
    for dept in departments:
        m = dept.manager
        planned = m.planned()
        days = []
        if planned:
            a = planned[0]
            days += [a.start - timedelta(days=2), a.start + timedelta(days=1)]
            days += [a.end - timedelta(days=1), a.back + timedelta(days=1)]
            if a.delegate and a.last_delegated_day < a.end:
                days += [a.last_delegated_day + timedelta(days=2)]
        else:
            days += [d(13), d(20), d(27)]
        while len(days) < per_dept:
            days.append(rng.choice(days))
        cover = {a.delegate for a in planned} | {a.informal for a in planned}
        staff = [p for p in dept.staff if p not in cover] or dept.staff
        for i, day in enumerate(days[:per_dept]):
            day = next_weekday(day)
            person = staff[i % len(staff)]
            absence = m.absence_on(day)
            kind = "plain"
            if i == per_dept - 1:
                kind = "already_approved"
                # 「X は既に承認した」を曖昧にしないよう、質問日の X は勤務中にする。
                while absence:
                    day, absence = absence.back, m.absence_on(absence.back)
            elif absence and absence.informal:
                informal_count = sum(r["name"].endswith("informal_claim") for r in rows)
                if informal_count < 2 + (dept is departments[-1]):
                    kind = "informal_claim"
            rows.append(make_row(dept, person, day, rng, kind))
    return rows


# 通常の計画からは生成されない難しいケース。開発用には各種別を一つずつ含め、
# ホールドアウトでは人名、日付、金額を変える。
# (種別、部門、従業員、判断日、品目、合計または None、取得済み見積書数、非公式な代行)
CATEGORY_MANAGER = "Marco Bianchi"  # people.json: 10月19日から30日まで休暇、11月2日に復帰
CM_LEAVE, CM_BACK = (d(19), d(30)), d(2, 11)
HARD_DEVELOPMENT = [
    (
        "over_threshold",
        "Engineering",
        "Nadia Petrova",
        d(22),
        "役員会議室用のビデオ会議システム",
        8900,
        1,
        False,
    ),
    (
        "over_threshold",
        "Finance",
        "Chiara Rossi",
        d(3, 11),
        "新入社員2人用のノートPC",
        6200,
        0,
        False,
    ),
    (
        "missing_total",
        "Facilities",
        "Sione Taufa",
        d(14),
        "オフィスのキッチン用のコーヒーメーカー",
        None,
        0,
        False,
    ),
    (
        "asked_to_act",
        "Legal",
        "Priscilla Adeyemi",
        d(28),
        "オフィス用のプリンタートナー",
        340,
        1,
        False,
    ),
]
HARD_HOLDOUT = [
    (
        "over_threshold",
        "Customer Support",
        "Olivia Brennan",
        d(27),
        "会議室用のモニター一式",
        7400,
        2,
        True,
    ),
    (
        "over_threshold",
        "Quality Assurance",
        "Wen Li",
        d(14),
        "買い替え用の試験ラボ向けノートPC",
        9300,
        0,
        False,
    ),
    (
        "missing_total",
        "Logistics",
        "Kenji Mori",
        d(29),
        "オフィス受付用の来客椅子2脚",
        None,
        0,
        False,
    ),
    (
        "asked_to_act",
        "Quality Assurance",
        "Vikram Rao",
        d(13),
        "会議室用のスピーカー",
        1260,
        1,
        False,
    ),
]
QUOTES_TEXT = {0: "", 1: "取引先の見積書は1件あります。", 2: "取引先の見積書は2件あります。"}


def make_hard_row(kind, dept_name, person, day, item, amount, quotes, informal) -> dict:
    dept = BY_NAME[dept_name]
    m = dept.manager
    cfirst = CATEGORY_MANAGER.split()[0]
    cost = f"を ${amount:,} で" if amount else "を"
    query = f"今日は{fmt(day)}です。私は{dept.display_name}の {person} です。"
    criteria = ["answer_first", "concise"]
    if kind == "asked_to_act":
        assert m.absence_on(day) is None
        query += (
            f"{item}について ${amount:,} の取引先見積書が1件あります。承認して発注してください。"
        )
        gt = (
            f"購入の承認や発注はできません。次に、発注前に直属上司 {m.name} の承認を得てください。"
            "見積書の要件は満たしています。"
        )
        refs = ["policy:purchasing", f"people:mgr-{slug(m.name)}"]
        criteria += ["current_approver", "no_commitment"]
    elif kind == "missing_total":
        query += f"{item}を購入できますか？"
        gt = (
            "まだ判断できません。合計金額はいくらですか？"
            "見積書と支出承認の要件は合計金額で決まります。"
        )
        refs = ["policy:purchasing"]
        criteria += ["asks_for_total"]
    else:  # しきい値を超えるケース
        query += f"{item}{cost}購入できますか？{QUOTES_TEXT[quotes]}"
        if informal:
            query += f"{cfirst} は不在ですが、不在通知には Sam Lee に相談するよう書かれています。"
        quote_step = {
            0: "取引先の見積書を2件取得してください",
            1: "2件目の取引先見積書を取得してください",
        }
        on_leave = CM_LEAVE[0] <= day <= CM_LEAVE[1]
        refs = ["policy:purchasing", "people:category-manager"]
        criteria += ["category_route", "no_reopened_steps"]
        if not on_leave:
            gt = (
                f"まだ購入できません。${amount:,} は $5,000 を超えるため、"
                "購入前に取引先の見積書2件と"
                f"カテゴリーマネージャー {CATEGORY_MANAGER} の承認が必要です。"
            )
            gt += (
                f"次に、{quote_step[quotes]}。その後、{cfirst} に承認を依頼してください。"
                if quotes < 2
                else f"見積書は2件とも揃っています。次に、{cfirst} に承認を依頼してください。"
            )
            criteria.append("current_approver")
        else:
            gt = (
                f"まだ購入できません。${amount:,} は $5,000 を超えるため、取引先の見積書2件と"
                "カテゴリーマネージャーの承認が必要です。"
                f"カテゴリーマネージャー {CATEGORY_MANAGER} は"
                f"休暇中で{short(CM_BACK)}に復帰します。委任の記録がないため、他の人は承認できません。"
            )
            gt += (
                f"まず{quote_step[quotes]}。その後、"
                if quotes < 2
                else "見積書は2件とも揃っています。"
            )
            gt += (
                f"{short(CM_BACK)}の {cfirst} の復帰を待つか、"
                "購買部門に承認権限を持つ人を確認してください。"
            )
            refs.insert(1, "policy:approval-delegation")
            criteria.append("no_substitute")
            if informal:
                gt += "Sam Lee への相談の提案は非公式なもので、承認権限を与えるものではありません。"
                criteria.append("evidence_not_authority")
        if item.startswith("買い替え用"):
            gt += (
                "買い替え設備を購入する前に、再利用できる適切な設備がないことを"
                "資産管理チームにも確認してください。"
            )
            refs.append("policy:sustainable-purchasing")
            criteria.append("replacement_reuse")
    gt += " 出典: " + " ".join(f"[{r}]" for r in refs) + "。"
    return {
        "name": f"{slug(dept.name)}-{slug(person)}-{day:%m%d}-{kind}",
        "query": query,
        "ground_truth": gt,
        "criteria": [{"name": c, "instruction": CRITERIA[c]} for c in criteria],
    }


def write(name: str, rows: list[dict]) -> None:
    path = DATASETS / f"{name}.jsonl"
    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
    )
    print(f"{path.relative_to(SAMPLE)}: {len(rows)} 件")


def main() -> None:
    rng = random.Random(SEED)
    records = roster_records()
    ROSTER.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write(
        "approvers-development",
        plan(TRAIN, rng, per_dept=6) + [make_hard_row(*h) for h in HARD_DEVELOPMENT],
    )
    write(
        "approvers-holdout",
        plan(VALIDATION, rng, per_dept=6) + [make_hard_row(*h) for h in HARD_HOLDOUT],
    )
    drift_rng = random.Random(SEED + 1)
    write(
        "approvers-drift",
        [make_row(BY_NAME[dept], person, day, drift_rng, "plain") for dept, person, day in DRIFT],
    )
    print(f"{ROSTER.relative_to(SAMPLE)}: {len(records)} レコード")


if __name__ == "__main__":
    main()
