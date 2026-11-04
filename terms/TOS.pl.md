# Regulamin

**Ostatnia aktualizacja:** [data]

> **To szablon, a nie regulamin tej instancji.** Osoba, która prowadzi tę instancję, zastępuje go własnym regulaminem, zgodnym z prawem, które jej dotyczy, zanim ktokolwiek inny założy konto. Każdy fragment w nawiasach kwadratowych uzupełnia albo usuwa ona sama. To, co aplikacja mówi o sobie i swojej licencji, jest pokazane pod regulaminem i nie należy do tego pliku.

## 1. Czym to jest

Tę instancję Diet App, aplikacji do planowania posiłków, prowadzi [operator: osoba albo organizacja oraz jej siedziba]. Operator odpowiada za jej dostępność, za Twoje dane oraz za gwarancje, które zdecyduje się oferować.

## 2. Konta

Założenie konta wymaga adresu e-mail i hasła, które trzymasz w tajemnicy. Za ich bezpieczeństwo odpowiadasz Ty. [Kto może założyć konto: każdy albo tylko osoby zaproszone przez operatora.] Usunięcie konta jest trwałe: znika każdy związany z nim zapis (profile, plany posiłków, dziennik, własne produkty, ulubione, spiżarnia, zapis użycia AI) bez możliwości odzyskania.

## 3. Własne klucze AI i AI instancji

Gdy dodasz w Ustawieniach klucz dostawcy AI, instancja przechowuje go zaszyfrowany, ale nadal obowiązują Cię regulamin i cennik tego dostawcy. Gdy korzystasz z AI instancji, operator płaci za Twoje zapytania w miesięcznych limitach, które pokazuje aplikacja. Operator decyduje o tym, które konta mogą z niego korzystać. Może też ten dostęp odebrać, na przykład po nadużyciu. [Jeśli AI instancji jest włączone: przez jaką usługę działa i gdzie.] Zapytanie zawiera to, czego potrzebuje, na przykład składniki przepisu, posiłki planu, dietę i preferencje profilu albo kalorie zapisane w dzienniku danego dnia. Nigdy nie zawiera Twojego adresu e-mail ani hasła. Z własnym kluczem zapytanie trafia zamiast tego do dostawcy tego klucza.

## 4. To nie porada medyczna

Każda wartość kalorii i makroskładników przepisu i planu posiłków jest wyliczana z prowadzonej bazy składników; posiłek własny ma wartości, które sam wpisujesz, a produkt z kodem kreskowym wartości z etykiety, które podają użytkownicy Open Food Facts. To wartości przybliżone, niesprawdzane pod kątem żadnych zastosowań medycznych ani terapeutycznych.

Cel kaloryczny profilu i tempo utraty wagi są wyliczane ze wzoru dla dorosłych na podstawie wieku, płci, wzrostu, wagi i aktywności. To przybliżenie dla zdrowej osoby dorosłej: aplikacja nie zna Twojego stanu zdrowia, niczego nie diagnozuje ani nie leczy i nie zastępuje lekarza ani dietetyka.

Zanim zaczniesz odchudzanie albo zmienisz dietę, zapytaj lekarza lub dietetyka, jeśli:

- masz mniej niż 18 lat;
- jesteś w ciąży albo karmisz piersią;
- masz zaburzenia odżywiania teraz albo w przeszłości;
- chorujesz przewlekle (na przykład na cukrzycę albo choroby nerek) albo przyjmujesz leki, na które wpływa dieta.

Jeśli podczas diety źle się poczujesz, przerwij ją i skontaktuj się z lekarzem. Z diety, celów i planów aplikacji korzystasz na własną odpowiedzialność. Operator nie odpowiada za szkody wynikające z ich stosowania, w granicach opisanych w punkcie 10.

## 5. Treści tworzone z pomocą AI

Przepisy, zamiany i podpowiedzi przygotowane z pomocą AI mają znacznik ✨. Sprawdź je, zanim zaczniesz z nich korzystać: aplikacja przelicza ich wartości odżywcze z bazy składników, ale dobór składników i kroki pochodzą od modelu.

## 6. Przepisy, którymi się dzielisz

Przepis zgłoszony do wspólnej biblioteki jest przez samo zgłoszenie udostępniany na licencji aplikacji, czyli GNU Affero General Public License w wersji 3. Przepis napisany dla Ciebie przez AI instancji trafia do kuratorów sam, bez Twojego imienia, a jeśli go przyjmą, jest udostępniany na tej samej licencji.

## 7. Twoje dane

Twoje konto zawiera adres e-mail, który instancja przechowuje zaszyfrowany, oraz hasło, zapisane tylko w postaci, z której nie da się go odczytać. Zawiera też to, co wpisujesz: profile (na przykład wiek, płeć, wzrost, wagę, cele i upodobania kulinarne), wpisy wagi, wpisy dziennika, plany posiłków i listy zakupów, spiżarnię, własne produkty, oznaczone przepisy i własne przepisy, sesje logowania, dodane klucze dostawców AI (zaszyfrowane) oraz zapis użycia AI. Dane są przechowywane w bazie tej instancji, na [gdzie stoi serwer]. [Jak często operator robi kopie zapasowe, jak długo je trzyma i kto może je czytać.] [Jeśli instancja wysyła e-maile: przez jaką usługę.] Wszystko, co zawiera Twoje konto, możesz w każdej chwili pobrać w Ustawieniach jako jeden plik. Usunięcie konta od razu usuwa je z bazy; kopie zrobione wcześniej zostają, dopóki nie zostaną zastąpione.

## 8. Ochrona przed botami

[Usuń tę sekcję, jeśli instancja nie korzysta z Cloudflare Turnstile.] Logowanie, rejestrację i reset hasła chroni Cloudflare Turnstile. Na tych stronach przeglądarka ładuje weryfikację Cloudflare, więc Cloudflare widzi Twój adres IP i dane przeglądarki.

## 9. Produkty z kodem kreskowym

[Usuń tę sekcję, jeśli instancja nie sprawdza kodów ani nie importuje produktów.] Kod kreskowy, który zeskanujesz albo wpiszesz, sprawdza ta instancja: najpierw we własnej tabeli produktów, a jeśli go tam nie ma, pyta Open Food Facts we własnym imieniu. Open Food Facts widzi serwer instancji, nie Ciebie. Instancja nie zapisuje przy Twoim koncie, o jakie kody pytasz, a jedynie to, że pytanie padło i usuwa ten zapis po dobie. Kod jest częścią adresu zapytania, więc trafia do logów serwera pośredniczącego przed instancją, jeśli jakiś je zapisuje. Wpis produktu w dzienniku należy do Twoich danych. Wartości produktów wpisują użytkownicy Open Food Facts i mogą być błędne: aplikacja sprawdza tylko, czy się zgadzają, więc porównaj je z opakowaniem. Dane Open Food Facts są dostępne na licencji Open Database License (ODbL), a tabela produktów tej instancji jest udostępniana na tej samej licencji, jak opisano pod regulaminem.

Produkt, którego nie ma w tabeli, możesz wpisać sam i pozostaje on tylko Twój. Jego kod jest sprawdzany tak samo, od razu i później; gdy Open Food Facts albo ta instancja pozna ten kod, Twoja kopia ustępuje, dostajesz o tym informację, a dziennik zachowuje to, co zapisał. Jeśli wyślesz produkt do bazy, sprawdzający tej instancji czytają go, nie widząc, czyj jest. Przyjęty produkt należy do bazy: każdy na tej instancji może go znaleźć, jest udostępniany na tej samej licencji w pliku bez informacji, kto co dodał i zostaje po usunięciu Twojego konta. Administrator może go wycofać, podając powód, a wtedy wraca do Ciebie. Produkt niewysłany, czekający i nieprzyjęty znika razem z kontem.

## 10. Odpowiedzialność

[Odpowiedzialność operatora, w granicach, w jakich prawo, które go dotyczy, pozwala ją ograniczyć.]

## 11. Zmiany

Ten regulamin może się zmieniać. [Jak operator ogłasza zmianę: e-mailem albo komunikatem w aplikacji.] Korzystanie z instancji po ogłoszeniu zmiany oznacza jej akceptację.
