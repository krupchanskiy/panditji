"""Маппинг английских названий gaurabda → ISKCON-русский.

Полный покрытие — недостижимо (gaurabda знает ~250+ событий). Покрываем то, что
реально важно для Адриана: экадаши + крупные явления/уходы + аштами+чатурдаши
основных аватаров и ачарьев Гаудия-сампрадаи. Всё остальное проходит как есть
(английский текст → попадает в БД как event_name) и при необходимости переводится
вручную позже.

Сигналом "не переведено" служит то, что event_name содержит латиницу.
"""

# Названия экадаши — 25 канонических + Падмини/Парама для адхика-масы
EKADASHI_NAMES = {
    'Sat-tila Ekadasi':         'Шат-тила Экадаши',
    'Bhaimi Ekadasi':           'Бхайми Экадаши',
    'Jaya Ekadasi':             'Джая Экадаши',
    'Vijaya Ekadasi':           'Виджая Экадаши',
    'Amalaki vrata Ekadasi':    'Амалаки-врата Экадаши',
    'Papamocani Ekadasi':       'Папамочани Экадаши',
    'Kamada Ekadasi':           'Камада Экадаши',
    'Varuthini Ekadasi':        'Варутхини Экадаши',
    'Mohini Ekadasi':           'Мохини Экадаши',
    'Apara Ekadasi':            'Апара Экадаши',
    'Padmini Ekadasi':          'Падмини Экадаши',
    'Parama Ekadasi':           'Парама Экадаши',
    'Pandava Nirjala Ekadasi':  'Пандава Нирджала Экадаши',
    'Yogini Ekadasi':           'Йогини Экадаши',
    'Sayana Ekadasi':           'Шаяна Экадаши',
    'Kamika Ekadasi':           'Камика Экадаши',
    'Pavitraropana Ekadasi':    'Павитропана Экадаши',
    'Annada Ekadasi':           'Аннада Экадаши',
    'Parsva Ekadasi':           'Паршва Экадаши',
    'Indira Ekadasi':           'Индира Экадаши',
    'Pasankusa Ekadasi':        'Пашанкуша Экадаши',
    'Rama Ekadasi':             'Рама Экадаши',
    'Utthana Ekadasi':          'Уттхана Экадаши',
    'Utpanna Ekadasi':          'Утпанна Экадаши',
    'Moksada Ekadasi':           'Мокшада Экадаши',
    'Saphala Ekadasi':          'Сапхала Экадаши',
    'Putrada Ekadasi':          'Путрада Экадаши',
}

# Крупные явления/уходы — те, что в плане прямо упомянуты как обязательные
MAJOR_FESTIVALS = {
    'Gaura Purnima: Appearance of Sri Caitanya Mahaprabhu':
        'Гаура-пурнима — Явление Шри Чайтаньи Махапрабху',
    'Sri Krsna Janmastami: Appearance of Lord Sri Krsna':
        'Шри Кришна-джанмаштами — Явление Господа Кришны',
    'Rama Navami: Appearance of Lord Sri Ramacandra':
        'Рама-навами — Явление Господа Рамачандры',
    'Nrsimha Caturdasi: Appearance of Lord Nrsimhadeva':
        'Нрисимха-чатурдаши — Явление Господа Нрисимхадевы',
    'Radhastami: Appearance of Srimati Radharani':
        'Радхаштами — Явление Шримати Радхарани',
    'Balarama Purnima: Appearance of Lord Balarama':
        'Баларама-пурнима — Явление Господа Баларамы',
    'Nityananda Trayodasi: Appearance of Sri Nityananda Prabhu':
        'Нитьянанда-трайодаши — Явление Шри Нитьянанды Прабху',
    'Varaha Dvadasi: Appearance of Lord Varahadeva':
        'Вараха-двадаши — Явление Господа Варахи',
    'Vamana Dvadasi: Appearance of Lord Vamanadeva':
        'Вамана-двадаши — Явление Господа Ваманы',
    'Ratha Yatra':
        'Ратха-ятра',
    'Govardhana Puja':
        'Говардхана-пуджа',
    'Go Puja. Go Krda. Govardhana Puja.':
        'Гопуджа. Гокрида. Говардхана-пуджа',
    'Guru (Vyasa) Purnima':
        'Гуру (Вьяса) Пурнима',

    # Шестеро Госвами Вриндавана — appearance/disappearance
    'Srila Rupa Gosvami -- Appearance':         'Шрила Рупа Госвами — Явление',
    'Srila Rupa Gosvami -- Disappearance':      'Шрила Рупа Госвами — Уход',
    'Srila Sanatana Gosvami -- Appearance':     'Шрила Санатана Госвами — Явление',
    'Srila Sanatana Gosvami -- Disappearance':  'Шрила Санатана Госвами — Уход',
    'Srila Raghunatha Bhatta Gosvami -- Appearance':      'Шрила Рагхунатха Бхатта Госвами — Явление',
    'Srila Raghunatha Bhatta Gosvami -- Disappearance':   'Шрила Рагхунатха Бхатта Госвами — Уход',
    'Srila Gopala Bhatta Gosvami -- Appearance':          'Шрила Гопала Бхатта Госвами — Явление',
    'Srila Gopala Bhatta Gosvami -- Disappearance':       'Шрила Гопала Бхатта Госвами — Уход',
    'Srila Raghunatha Dasa Gosvami -- Appearance':        'Шрила Рагхунатха Даса Госвами — Явление',
    'Srila Raghunatha Dasa Gosvami -- Disappearance':     'Шрила Рагхунатха Даса Госвами — Уход',
    'Srila Jiva Gosvami -- Appearance':                   'Шрила Джива Госвами — Явление',
    'Srila Jiva Gosvami -- Disappearance':                'Шрила Джива Госвами — Уход',

    # Прабхупада и его учителя
    'Srila Prabhupada -- Appearance':
        'Шрила Прабхупада — Явление',
    'A.C. Bhaktivedanta Swami Srila Prabhupada -- Disappearance':
        'А.Ч. Бхактиведанта Свами Шрила Прабхупада — Уход',
    'Srila Bhaktisiddhanta Sarasvati Thakura -- Appearance':
        'Шрила Бхактисиддханта Сарасвати Тхакур — Явление',
    'Srila Bhaktisiddhanta Sarasvati Thakura -- Disappearance':
        'Шрила Бхактисиддханта Сарасвати Тхакур — Уход',
    'Srila Bhaktivinoda Thakura -- Appearance':
        'Шрила Бхактивинода Тхакур — Явление',
    'Srila Bhaktivinoda Thakura -- Disappearance':
        'Шрила Бхактивинода Тхакур — Уход',
    'Srila Gaurakisora Dasa Babaji -- Disappearance':
        'Шрила Гауракишора Даса Бабаджи — Уход',
    'Srila Jagannatha Dasa Babaji -- Disappearance':
        'Шрила Джаганнатха Даса Бабаджи — Уход',

    # Авторы канонических текстов и ачарьи линии преемственности
    'Srila Vrndavana Dasa Thakura -- Appearance':         'Шрила Вриндавана Дас Тхакур — Явление',
    'Srila Vrndavana Dasa Thakura -- Disappearance':      'Шрила Вриндавана Дас Тхакур — Уход',
    'Sri Madhavendra Puri -- Appearance':                 'Шри Мадхавендра Пури — Явление',
    'Sri Madhavendra Puri -- Disappearance':              'Шри Мадхавендра Пури — Уход',
    'Sri Srinivasa Acarya -- Appearance':                 'Шри Шринивас Ачарья — Явление',
    'Sri Srinivasa Acarya -- Disappearance':              'Шри Шринивас Ачарья — Уход',
    'Sri Ramananda Raya -- Disappearance':                'Шри Рамананда Рай — Уход',
    'Sri Advaita Acarya -- Appearance':                   'Шри Адвайта Ачарья — Явление',
    'Sri Advaita Acarya -- Disappearance':                'Шри Адвайта Ачарья — Уход',
    'Sri Nityananda Prabhu -- Disappearance':             'Шри Нитьянанда Прабху — Уход',
    'Sri Visvanatha Cakravarti Thakura -- Appearance':    'Шри Вишванатха Чакраварти Тхакур — Явление',
    'Srila Visvanatha Cakravarti Thakura -- Disappearance': 'Шрила Вишванатха Чакраварти Тхакур — Уход',
    'Srila Narottama Dasa Thakura -- Appearance':         'Шрила Нароттама Дас Тхакур — Явление',
    'Srila Narottama Dasa Thakura -- Disappearance':      'Шрила Нароттама Дас Тхакур — Уход',
    'Sri Srivasa Pandita -- Appearance':                  'Шри Шриваса Пандит — Явление',
    'Sri Srivasa Pandita -- Disappearance':               'Шри Шриваса Пандит — Уход',
    'Sri Gadadhara Pandita -- Appearance':                'Шри Гададхара Пандит — Явление',
    'Sri Gadadhara Pandita -- Disappearance':             'Шри Гададхара Пандит — Уход',
    'Sri Baladeva Vidyabhusana -- Disappearance':         'Шри Баладева Видьябхушана — Уход',
    'Sri Ramanujacarya -- Appearance':                    'Шри Рамануджачарья — Явление',
    'Sri Ramanujacarya -- Disappearance':                 'Шри Рамануджачарья — Уход',
    'Sri Madhvacarya -- Disappearance':                   'Шри Мадхвачарья — Уход',
    'Sri Isvara Puri -- Disappearance':                   'Шри Ишвара Пури — Уход',
    'Sri Mukunda Datta -- Disappearance':                 'Шри Мукунда Датта — Уход',
    'Sri Syamananda Prabhu -- Appearance':                'Шри Шьямананда Прабху — Явление',
    'Sri Syamananda Prabhu -- Disappearance':             'Шри Шьямананда Прабху — Уход',
    'Srimati Sita Devi (consort of Lord Sri Rama) -- Appearance':
        'Шримати Сита Деви — Явление',
    'Srimati Jahnava Devi -- Appearance':                 'Шримати Джахнава Деви — Явление',
    'Sri Sri Radha-Ramana Devaji -- Appearance':          'Шри Шри Радха-Рамана Деваджи — Явление',
    'Appearance of Radha Kunda, snana dana':              'Радха-кунда — день омовения',
    'Srimati Gangamata Gosvamini -- Appearance':          'Шримати Гангамата Госвамини — Явление',
    'Sri Vamsivadana Thakura -- Appearance':              'Шри Вамшивадана Тхакур — Явление',
    'Sri Vakresvara Pandita -- Appearance':               'Шри Вакрешвара Пандит — Явление',
    'Sri Vakresvara Pandita -- Disappearance':            'Шри Вакрешвара Пандит — Уход',
    'Sri Svarupa Damodara Gosvami -- Disappearance':      'Шри Сварупа Дамодара Госвами — Уход',
    'Sri Sivananda Sena -- Disappearance':                'Шри Шивананда Сена — Уход',
    'Sri Pundarika Vidyanidhi -- Appearance':             'Шри Пундарика Видьянидхи — Явление',
    'Sri Raghunandana Thakura -- Appearance':             'Шри Рагхунандана Тхакур — Явление',
    'Sri Rasikananda -- Disappearance':                   'Шри Расикананда — Уход',
    'Sri Locana Dasa Thakura -- Disappearance':           'Шри Лочана Дас Тхакур — Уход',
    'Sri Jayadeva Gosvami -- Disappearance':              'Шри Джаядева Госвами — Уход',
    'Sri Ramacandra Kaviraja -- Disappearance':           'Шри Рамачандра Кавираджа — Уход',
    'Sri Govinda Ghosh -- Disappearance':                 'Шри Говинда Гхош — Уход',
    'Sri Abhirama Thakura -- Disappearance':              'Шри Абхирама Тхакур — Уход',
    'Srila Jagannatha Dasa Babaji -- Appearance':         'Шрила Джаганнатха Даса Бабаджи — Явление',
    'Sri Madhu Pandita -- Disappearance':                 'Шри Мадху Пандит — Уход',
    'Sri Jayananda Prabhu -- Disappearance':              'Шри Джаянанда Прабху — Уход',
    'Sri Paramesvari Dasa Thakura -- Disappearance':      'Шри Парамешвари Дас Тхакур — Уход',
    'Sri Purusottama Das Thakura -- Disappearance':       'Шри Пурушоттама Дас Тхакур — Уход',
    'Sri Purusottama Dasa Thakura -- Appearance':         'Шри Пурушоттама Дас Тхакур — Явление',
    'Srimati Visnupriya Devi -- Appearance':              'Шримати Вишнуприя Деви — Явление',

    # Прочие праздники
    'Damanakaropana Dvadasi':                             'Даманакаропана Двадаши',
    'Rukmini Dvadasi':                                    'Рукмини Двадаши',
    'Sri Balarama Rasayatra':                             'Шри Баларама Расаятра',
    'Sri Krsna Vasanta Rasa':                             'Шри Кришна Васанта Раса',
    'Krsna Phula Dola, Salila Vihara':                    'Кришна Пхула Дола, Салила Вихара',
    'Jahnu Saptami':                                      'Джахну Саптами',
    'Aksaya Trtiya. Candana Yatra starts. (Continues for 21 days)':
        'Акшая Тритья. Чандана Ятра начинается (21 день)',
    'Festival of Jagannatha Misra':                       'Праздник Джаганнатха Мишры',
    'Panihati Cida Dahi Utsava':                          'Панихати Чида Дахи Утсава',
    'Snana Yatra':                                        'Снана Ятра',
    'Ganga Puja':                                         'Ганга Пуджа',
    'Hera Pancami (4 days after Ratha Yatra)':            'Хера Панчами (4 дня после Ратха-ятры)',
    'Return Ratha (8 days after Ratha Yatra)':            'Возвратная Ратха (8 дней после Ратха-ятры)',
}


def translate(name: str) -> str:
    """Переводит англ. название gaurabda в ISKCON-русский. Если нет в словаре —
    возвращает оригинал."""
    if not name:
        return name
    if name in EKADASHI_NAMES:
        return EKADASHI_NAMES[name]
    if name in MAJOR_FESTIVALS:
        return MAJOR_FESTIVALS[name]
    return name
