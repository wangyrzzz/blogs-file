public final class OrderRoute {
    public record Route(int database,int table,int slot) {
        public String physicalTable() {
            return "orders_"+String.format("%04d",table);
        }
    }
    // 教学示例：生产需固定可跨语言重现的 hash 算法与路由版本。
    public static Route route(long userId) {
        int slot=(int)Math.floorMod(userId,8L);
        return new Route(slot/4,slot%4,slot);
    }
    public static void main(String[] args) {
        for (long id=0;id<16;id++) {
            Route route=route(id);
            System.out.printf("user=%d -> ds%d.%s slot=%d%n",
                id,route.database(),route.physicalTable(),route.slot());
        }
    }
}